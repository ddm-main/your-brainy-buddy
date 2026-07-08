// JARVIS HUD — zero-dependency Node server.
// Serves the HUD frontend, /api/state (aggregate of the Supabase backend),
// write endpoints (capture, focus, inbox) that update BOTH the markdown OS
// (source of truth) and Supabase, and a read-only Gmail OAuth integration.
// Credentials come from process env or Apps/hud/.env (gitignored).
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OS_ROOT = join(__dirname, '..', '..'); // E:\Claude\JARVIS

const envFile = join(__dirname, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORT = Number(process.env.PORT || 3960);
const PUBLIC_DIR = join(__dirname, 'public');
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GMAIL_TOKEN_FILE = join(__dirname, '.gmail-token.json');
const REDIRECT_URI = `http://localhost:${PORT}/api/gmail/callback`;

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local
const hasSupabase = () => !!(SUPABASE_URL && KEY);

function encodeLocalId(type, payload) {
  return `local:${type}:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function decodeLocalId(id, type) {
  const prefix = `local:${type}:`;
  if (!id?.startsWith(prefix)) return null;
  try { return JSON.parse(Buffer.from(id.slice(prefix.length), 'base64url').toString('utf8')); }
  catch { return null; }
}

function parseSection(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^##\\s*${escaped}\\s*$([\\s\\S]*?)(?=^##\\s|\\Z)`, 'mi'));
  return match?.[1]?.trim() || '';
}

function buildStateEnvelope(parts) {
  return {
    generatedAt: new Date().toISOString(),
    gmail: gmailStatus(),
    settings: loadSettings(),
    voice: { ai: !!(GEMINI_KEY || OPENROUTER_KEY) },
    ...parts,
  };
}

/* ---------------- Supabase helpers ---------------- */
const sbHeaders = {
  apikey: KEY, Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json', Prefer: 'return=representation',
};
async function sb(method, path, body) {
  if (!hasSupabase()) throw new Error('Supabase credentials not configured');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers: sbHeaders, body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${r.status} ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}
const q = (path) => sb('GET', path);

async function remoteState() {
  const [projects, actions, inbox, areas, memories, logs] = await Promise.all([
    q('projects?select=*&status=eq.active&order=updated_at.desc'),
    q('next_actions?select=*&done=is.false&order=created_at.asc'),
    q('inbox_items?select=*&processed=is.false&order=created_at.asc'),
    q('areas?select=*&order=name.asc'),
    q('memories?select=category,content,updated_at&order=updated_at.desc&limit=100'),
    q('daily_logs?select=*&order=log_date.desc&limit=7'),
  ]);
  return buildStateEnvelope({
    online: true,
    remoteOnline: true,
    projects, actions, inbox, areas, memories, logs,
  });
}

function localLogs() {
  const dir = join(OS_ROOT, 'System', 'Logs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .map((name) => ({
      log_date: name.replace(/\.md$/, ''),
      content: readFileOr(join(dir, name), ''),
    }))
    .sort((a, b) => String(b.log_date).localeCompare(String(a.log_date)))
    .slice(0, 7);
}

function localInbox() {
  const text = readFileOr(join(OS_ROOT, 'Inbox', 'inbox.md'), '');
  return [...text.matchAll(/^- \[ \] (\d{4}-\d{2}-\d{2}) · (.+)$/gm)].map(([, captured_on, content]) => ({
    id: encodeLocalId('inbox', { captured_on, content }),
    captured_on,
    content,
  }));
}

function localProjectsAndActions() {
  const dir = join(OS_ROOT, 'Projects');
  if (!existsSync(dir)) return { projects: [], actions: [] };
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith('.'));

  const projects = [];
  const actions = [];
  for (const folder of folders) {
    const slug = folder.name;
    const overview = join(dir, slug, '_overview.md');
    if (!existsSync(overview)) continue;
    const text = readFileOr(overview, '');
    const title = text.match(/^# Project:\s+(.+)$/m)?.[1]?.trim() || slug;
    const statusLine = text.match(/^\*\*Status:\*\*\s+(.+)$/m)?.[1]?.trim() || 'active';
    const status = statusLine.split('·')[0].trim();
    const updated_at = statSync(overview).mtime.toISOString();
    projects.push({ id: slug, slug, title, status, updated_at });

    const nextActions = parseSection(text, 'Next actions');
    [...nextActions.matchAll(/^- \[ \] (.+)$/gm)].forEach((match) => {
      actions.push({
        id: encodeLocalId('action', { projectSlug: slug, description: match[1].trim() }),
        project_id: slug,
        description: match[1].trim(),
        created_at: updated_at,
      });
    });
  }

  projects.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return { projects, actions };
}

function localAreas() {
  const dir = join(OS_ROOT, 'Areas');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = join(dir, entry.name, '_overview.md');
      const text = readFileOr(file, '');
      const health = text.match(/^\*\*Health check \([^)]+\):\*\*\s+(.+)$/m)?.[1]?.trim() || '';
      return { name: entry.name, health_check: health };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function localMemories() {
  const dir = join(OS_ROOT, 'System', 'Memory');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name !== 'MEMORY.md')
    .flatMap((name) => {
      const file = join(dir, name);
      const updated_at = statSync(file).mtime.toISOString();
      const category = name.replace(/\.md$/, '');
      const text = readFileOr(file, '');
      const bullets = [...text.matchAll(/^- (.+)$/gm)].map((match) => match[1].trim());
      return bullets.length
        ? bullets.map((content) => ({ category, content, updated_at }))
        : [{ category, content: text.replace(/^# .+\n?/, '').trim(), updated_at }].filter((x) => x.content);
    })
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, 100);
}

function localState(error) {
  const { projects, actions } = localProjectsAndActions();
  return buildStateEnvelope({
    online: true,
    remoteOnline: false,
    degraded: true,
    error,
    projects,
    actions,
    inbox: localInbox(),
    areas: localAreas(),
    memories: localMemories(),
    logs: localLogs(),
  });
}

async function state() {
  if (!hasSupabase()) return localState('Supabase credentials not configured');
  try { return await remoteState(); }
  catch (e) { return localState(String(e.message || e)); }
}

async function syncIfPossible(work, label) {
  if (!hasSupabase()) return null;
  try { return await work(); }
  catch (e) {
    console.warn(`${label} sync skipped: ${e.message}`);
    return null;
  }
}

/* ---------------- file-side writes (files are the source of truth) ---------------- */
function readFileOr(path, fallback) { return existsSync(path) ? readFileSync(path, 'utf8') : fallback; }

function logPath(date) { return join(OS_ROOT, 'System', 'Logs', `${date}.md`); }

async function syncDailyLog(date) {
  const content = readFileOr(logPath(date), null);
  if (content === null) return;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/daily_logs?on_conflict=log_date`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ log_date: date, content }),
  });
  if (!r.ok) throw new Error(`daily_logs upsert: HTTP ${r.status} ${await r.text()}`);
}

async function captureInbox(content) {
  const file = join(OS_ROOT, 'Inbox', 'inbox.md');
  const line = `- [ ] ${today()} · ${content}`;
  writeFileSync(file, readFileOr(file, '# 📥 Inbox\n') .replace(/\s*$/, '') + `\n${line}\n`);
  await syncIfPossible(() => sb('POST', 'inbox_items', { content, captured_on: today(), processed: false }), 'Inbox capture');
}

async function processInbox(id) {
  let item = null;
  const local = decodeLocalId(id, 'inbox');
  if (local) item = local;
  else {
    [item] = await q(`inbox_items?id=eq.${encodeURIComponent(id)}&select=*`);
    if (!item) throw new Error('inbox item not found');
    await syncIfPossible(
      () => sb('PATCH', `inbox_items?id=eq.${encodeURIComponent(id)}`, { processed: true, routed_to: 'processed via HUD' }),
      'Inbox process',
    );
  }
  const file = join(OS_ROOT, 'Inbox', 'inbox.md');
  const txt = readFileOr(file, '');
  const escaped = item.content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  writeFileSync(file, txt.replace(new RegExp(`^(-\\s*)\\[ \\](\\s*[0-9-]+\\s*·\\s*${escaped})\\s*$`, 'm'), '$1[x]$2'));
}

function ensureTodayLog() {
  const p = logPath(today());
  if (!existsSync(p)) writeFileSync(p, `# ${today()}\n\n## Today's Focus\n`);
  let txt = readFileSync(p, 'utf8');
  if (!/^##\s*Today'?s Focus\s*$/mi.test(txt)) {
    txt = txt.replace(/\s*$/, '') + `\n\n## Today's Focus\n`;
    writeFileSync(p, txt);
  }
  return p;
}

async function addFocus(text) {
  const p = ensureTodayLog();
  writeFileSync(p, readFileSync(p, 'utf8').replace(/\s*$/, '') + `\n- [ ] ${text}\n`);
  await syncIfPossible(() => syncDailyLog(today()), 'Daily log');
}

async function toggleFocus(text, done) {
  const p = ensureTodayLog();
  const txt = readFileSync(p, 'utf8');
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const updated = txt.replace(new RegExp(`^(-\\s*)\\[[ xX]\\](\\s*${escaped})\\s*$`, 'm'), `$1[${done ? 'x' : ' '}]$2`);
  writeFileSync(p, updated);
  await syncIfPossible(() => syncDailyLog(today()), 'Daily log');
}

/* ---------------- settings ---------------- */
const SETTINGS_FILE = join(__dirname, 'settings.json');
const DEFAULT_SETTINGS = {
  accent: '#35d6ed', refreshSeconds: 30,
  panels: { focus: true, projects: true, finance: true, inbox: true, mail: true },
};
function loadSettings() {
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...saved, panels: { ...DEFAULT_SETTINGS.panels, ...saved.panels } };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  if (patch.panels) next.panels = { ...loadSettings().panels, ...patch.panels };
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

/* ---------------- projects / actions / areas / memories ---------------- */
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function createProject({ title, outcome, firstAction }) {
  const slug = slugify(title);
  if (!slug) throw new Error('invalid title');
  const dir = join(OS_ROOT, 'Projects', slug);
  const file = join(dir, '_overview.md');
  if (existsSync(file)) throw new Error(`project "${slug}" already exists`);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `# Project: ${title}

**Outcome:** ${outcome || '_to define_'}
**Deadline:** none
**Status:** active · started ${today()}

## Next actions
${firstAction ? `- [ ] ${firstAction}` : ''}

## Log
- ${today()} — project created (via HUD)
`);
  const created = await syncIfPossible(
    () => sb('POST', 'projects', { slug, title, outcome: outcome || null, status: 'active', started_on: today() }),
    'Project create',
  );
  const proj = created?.[0] || { id: slug, slug, title, outcome: outcome || null, status: 'active', updated_at: new Date().toISOString() };
  if (firstAction && created?.[0]?.id) {
    await syncIfPossible(() => sb('POST', 'next_actions', { project_id: proj.id, description: firstAction }), 'Next action create');
  }
  return proj;
}

async function completeAction(id) {
  let action = null;
  let projectSlug = null;
  const local = decodeLocalId(id, 'action');
  if (local) {
    action = { description: local.description };
    projectSlug = local.projectSlug;
  } else {
    [action] = await q(`next_actions?id=eq.${encodeURIComponent(id)}&select=*,projects(slug)`);
    if (!action) throw new Error('action not found');
    projectSlug = action.projects.slug;
    await syncIfPossible(
      () => sb('PATCH', `next_actions?id=eq.${encodeURIComponent(id)}`, { done: true, completed_at: new Date().toISOString() }),
      'Action complete',
    );
    await syncIfPossible(
      () => sb('PATCH', `projects?id=eq.${action.project_id}`, { updated_at: new Date().toISOString() }),
      'Project update',
    );
  }
  const file = join(OS_ROOT, 'Projects', projectSlug, '_overview.md');
  if (existsSync(file)) {
    const txt = readFileSync(file, 'utf8');
    writeFileSync(file, txt.replace(new RegExp(`^(-\\s*)\\[ \\](\\s*${escRe(action.description)})\\s*$`, 'm'), '$1[x]$2'));
  }
}

async function updateArea(name, health) {
  const file = join(OS_ROOT, 'Areas', name, '_overview.md');
  if (!existsSync(file)) throw new Error(`area "${name}" not found`);
  let txt = readFileSync(file, 'utf8');
  const line = `**Health check (${today()}):** ${health}`;
  txt = /^\*\*Health check \(.*$/m.test(txt)
    ? txt.replace(/^\*\*Health check \(.*$/m, line)
    : txt.replace(/^(# Area: .+)$/m, `$1\n\n${line}`);
  writeFileSync(file, txt);
  await syncIfPossible(
    () => sb('PATCH', `areas?name=eq.${encodeURIComponent(name)}`, { health_check: health, reviewed_at: new Date().toISOString() }),
    'Area update',
  );
}

async function addMemory(category, content) {
  const cat = slugify(category) || 'notes';
  const file = join(OS_ROOT, 'System', 'Memory', `${cat}.md`);
  if (!existsSync(file)) {
    writeFileSync(file, `# ${cat[0].toUpperCase()}${cat.slice(1)}\n\n- ${content}\n`);
    const idx = join(OS_ROOT, 'System', 'Memory', 'MEMORY.md');
    writeFileSync(idx, readFileOr(idx, '# Memory Index\n').replace(/\s*$/, '') + `\n- [${cat}](${cat}.md) — added via HUD\n`);
  } else {
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\s*$/, '') + `\n- ${content}\n`);
  }
  await syncIfPossible(
    () => sb('POST', 'memories', { category: cat, content, source_file: `System/Memory/${cat}.md` }),
    'Memory add',
  );
}

/* ---------------- Finance: transaction & statement tracking ---------------- */
// Scans connected Gmail accounts for transaction alerts and bank/card
// statements, parses amounts, and keeps a deduped ledger under
// Projects/finance/ (files are the source of truth).
const FIN_DIR = join(OS_ROOT, 'Projects', 'finance');
const LEDGER_FILE = join(FIN_DIR, 'transactions.json');
const TX_QUERY = 'newer_than:90d (debited OR credited OR spent OR withdrawn OR "transaction alert" OR "payment of" OR "purchase of" OR "sent via UPI" OR "txn")';
const ST_QUERY = 'newer_than:180d subject:statement (account OR card OR bank)';

function loadLedger() {
  try { return JSON.parse(readFileSync(LEDGER_FILE, 'utf8')); }
  catch { return { transactions: [], statements: [], scannedAt: null }; }
}

/* -- financial profile: accounts, cards, loans, goals, category rules -- */
const FIN_PROFILE_FILE = join(FIN_DIR, 'accounts.json');
const CATEGORIES = ['Food & Groceries', 'Shopping', 'Travel & Fuel', 'Bills & Utilities', 'Subscriptions', 'EMI & Loans', 'Investments', 'Transfers', 'Income', 'Cash', 'Other'];
const BUILTIN_RULES = [
  [/swiggy|zomato|dominos|mcdonald|kfc|blinkit|zepto|instamart|bigbasket|dmart|grocery/i, 'Food & Groceries'],
  [/amazon|flipkart|myntra|ajio|meesho|croma|snapdeal|nykaa/i, 'Shopping'],
  [/uber|ola |olacabs|rapido|irctc|redbus|makemytrip|goibibo|indigo|petrol|fuel|hpcl|iocl|bpcl/i, 'Travel & Fuel'],
  [/netflix|spotify|hotstar|prime video|youtube|google play|apple\.com|openai|anthropic/i, 'Subscriptions'],
  [/electricity|recharge|airtel|jio|vodafone|bsnl|dth|broadband|postpaid|gas bill|water bill|bill payment/i, 'Bills & Utilities'],
  [/emi|nach|ecs|loan|bajaj fin|bajajpay|finserv/i, 'EMI & Loans'],
  [/\b(zerodha|groww|upstox|mutual fund|sip|nps|ppf|elss|demat)\b/i, 'Investments'],
  [/salary|payroll/i, 'Income'],
  [/atm|cash wd|cash withdrawal/i, 'Cash'],
  [/vpa|upi_|upi\b/i, 'Transfers'],
];

function loadFinProfile() {
  try {
    const p = JSON.parse(readFileSync(FIN_PROFILE_FILE, 'utf8'));
    return { accounts: [], goals: [], rules: [], overrides: {}, ...p };
  } catch { return { accounts: [], goals: [], rules: [], overrides: {} }; }
}
async function saveFinProfile(p) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(FIN_DIR, { recursive: true });
  writeFileSync(FIN_PROFILE_FILE, JSON.stringify(p, null, 2));
}

function categorize(tx, profile) {
  if (profile.overrides[tx.id]) return profile.overrides[tx.id];
  const hay = `${tx.merchant} ${tx.subject} ${tx.from}`.toLowerCase();
  for (const r of profile.rules) if (r.match && hay.includes(r.match.toLowerCase())) return r.category;
  for (const [re, cat] of BUILTIN_RULES) if (re.test(hay)) return cat;
  return tx.type === 'credit' ? 'Income' : 'Other';
}

function matchAccount(tx, profile) {
  const hay = `${tx.subject} ${tx.merchant} ${tx.from}`;
  const digits = [...hay.matchAll(/(?:xx|\*+|ending(?: in)?|card no\.?|a\/c(?: no\.?)?|account)[\sx*.]*(\d{4})\b/gi)].map((m) => m[1]);
  const byDigits = profile.accounts.find((a) => a.last4 && digits.includes(a.last4));
  if (byDigits) return byDigits;
  const low = hay.toLowerCase();
  return profile.accounts.find((a) => a.institution && low.includes(a.institution.toLowerCase().split(' ')[0])) || null;
}

function decorateTransactions(ledger, profile) {
  return ledger.transactions.map((t) => {
    const a = matchAccount(t, profile);
    return { ...t, category: categorize(t, profile), accountId: a?.id || null, accountName: a?.name || null };
  });
}
async function saveLedger(ledger) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(FIN_DIR, { recursive: true });
  writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
}

function gmailBodyText(payload, snippet) {
  const found = [];
  (function walk(p) {
    if (!p) return;
    if (p.body?.data && (p.mimeType === 'text/plain' || p.mimeType === 'text/html')) found.push([p.mimeType, p.body.data]);
    (p.parts || []).forEach(walk);
  })(payload);
  const pick = found.find(([t]) => t === 'text/plain') || found[0];
  if (!pick) return snippet || '';
  let text = Buffer.from(pick[1], 'base64url').toString('utf8');
  if (pick[0] === 'text/html') {
    text = text.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  }
  return text.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim().slice(0, 5000);
}

function parseTransaction(text) {
  const m = text.match(/(?:INR|Rs\.?|₹|USD|\$)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!m) return null;
  const amount = Number(m[1].replace(/,/g, ''));
  if (!amount || amount > 10000000) return null;
  const currency = /\$|USD/i.test(m[0]) ? 'USD' : 'INR';
  const t = text.toLowerCase();
  const credit = /\b(credited|received|refund(ed)?|deposited|cashback)\b/.test(t) && !/\bdebited\b/.test(t);
  const merch = text.match(/\b(?:at|to|towards)\s+([A-Za-z0-9][\w .&*@'-]{2,40}?)(?=\s+(?:on|via|using|ref|txn|upi|info)\b|[.,]|\s*$)/i);
  let merchant = merch ? merch[1].trim() : '';
  // reject sentence fragments the at/to pattern tends to catch ("to help you…")
  if (/^(help|know|view|see|ensure|verify|continue|access|manage|protect|keep|get|make|check|avoid|your|you|us|the)\b/i.test(merchant)) merchant = '';
  return { amount, currency, type: credit ? 'credit' : 'debit', merchant };
}

async function gmailQuery(email, q, max) {
  const at = await gmailAccessToken(email);
  const gh = { Authorization: `Bearer ${at}` };
  const list = await (await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(q)}`,
    { headers: gh })).json();
  if (list.error) throw new Error(list.error.message);
  return { ids: (list.messages || []).map((m) => m.id), gh };
}

async function gmailMessage(id, gh) {
  const m = await (await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: gh })).json();
  if (m.error) throw new Error(m.error.message);
  const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
  return { msg: m, h };
}

async function scanFinance() {
  const ledger = loadLedger();
  const knownTx = new Set(ledger.transactions.map((t) => t.id));
  const knownSt = new Set(ledger.statements.map((s) => s.id));
  const errors = [];
  let added = 0;
  for (const email of Object.keys(tokenStore())) {
    try {
      const tx = await gmailQuery(email, TX_QUERY, 75);
      const fresh = tx.ids.filter((id) => !knownTx.has(id));
      const msgs = await Promise.allSettled(fresh.map((id) => gmailMessage(id, tx.gh)));
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].status !== 'fulfilled') continue;
        const { msg, h } = msgs[i].value;
        const parsed = parseTransaction(`${h.subject || ''} — ${gmailBodyText(msg.payload, msg.snippet)}`);
        if (!parsed) continue;
        const ts = Number(msg.internalDate || 0);
        ledger.transactions.push({
          id: fresh[i], account: email, ts,
          date: new Date(ts).toLocaleDateString('en-CA'),
          from: (h.from || '').replace(/\s*<.*>/, ''), subject: h.subject || '',
          ...parsed,
        });
        knownTx.add(fresh[i]);
        added++;
      }
      const st = await gmailQuery(email, ST_QUERY, 30);
      const freshSt = st.ids.filter((id) => !knownSt.has(id));
      const stMsgs = await Promise.allSettled(freshSt.map((id) => gmailMessage(id, st.gh)));
      for (let i = 0; i < stMsgs.length; i++) {
        if (stMsgs[i].status !== 'fulfilled') continue;
        const { msg, h } = stMsgs[i].value;
        const ts = Number(msg.internalDate || 0);
        ledger.statements.push({
          id: freshSt[i], account: email, ts,
          date: new Date(ts).toLocaleDateString('en-CA'),
          from: (h.from || '').replace(/\s*<.*>/, ''), subject: h.subject || '',
        });
        knownSt.add(freshSt[i]);
      }
    } catch (e) { errors.push(`${email}: ${e.message}`); }
  }
  ledger.transactions.sort((a, b) => b.ts - a.ts);
  ledger.statements.sort((a, b) => b.ts - a.ts);
  ledger.scannedAt = new Date().toISOString();
  await saveLedger(ledger);
  await writeExpensesMd(ledger);
  return { ledger, added, errors };
}

function financeTotals(ledger) {
  const months = {};
  for (const t of ledger.transactions) {
    if (t.currency !== 'INR') continue;
    const m = t.date.slice(0, 7);
    months[m] ??= { spent: 0, received: 0, count: 0 };
    months[m][t.type === 'debit' ? 'spent' : 'received'] += t.amount;
    months[m].count++;
  }
  return months;
}

async function writeExpensesMd(ledger) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(FIN_DIR, { recursive: true });
  const profile = loadFinProfile();
  const txs = decorateTransactions(ledger, profile);
  const months = financeTotals(ledger);
  const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
  const month = new Date().toLocaleDateString('en-CA').slice(0, 7);
  const byCat = {};
  for (const t of txs) if (t.date.startsWith(month) && t.type === 'debit' && t.currency === 'INR') byCat[t.category] = (byCat[t.category] || 0) + t.amount;
  const typeLabel = { bank: 'Bank account', credit_card: 'Credit card', loan: 'Loan' };
  const lines = [
    '# Expenses — auto-tracked from Gmail', '',
    `_Last scan: ${ledger.scannedAt} · ${ledger.transactions.length} transactions · ${ledger.statements.length} statements. Generated by the HUD — do not edit by hand._`, '',
    '## Accounts on file', '',
    ...(profile.accounts.length
      ? profile.accounts.map((a) => `- **${a.name}** — ${typeLabel[a.type] || a.type}${a.institution ? `, ${a.institution}` : ''}${a.last4 ? ` (••${a.last4})` : ''}${a.note ? ` — ${a.note}` : ''}`)
      : ['_none registered yet — add them in the HUD Finance section_']),
    '', '## Goals', '',
    ...(profile.goals.length
      ? profile.goals.map((g) => `- **${g.title}** — ${inr(g.saved)} / ${inr(g.target)} (${Math.round((g.saved / g.target) * 100)}%)${g.deadline ? ` · by ${g.deadline}` : ''}`)
      : ['_none yet_']),
    '', `## This month by category (${month})`, '',
    '| Category | Spent |', '|---|---|',
    ...Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `| ${c} | ${inr(v)} |`),
    '', '## Monthly totals', '',
    '| Month | Spent | Received | Transactions |', '|---|---|---|---|',
    ...Object.entries(months).sort((a, b) => b[0].localeCompare(a[0]))
      .map(([m, v]) => `| ${m} | ${inr(v.spent)} | ${inr(v.received)} | ${v.count} |`),
    '', '## Recent transactions', '',
    '| Date | Type | Amount | Merchant / Subject | Category | Account |', '|---|---|---|---|---|---|',
    ...txs.slice(0, 40).map((t) =>
      `| ${t.date} | ${t.type} | ${t.currency === 'USD' ? '$' : '₹'}${t.amount.toLocaleString('en-IN')} | ${(t.merchant || t.subject).replace(/\|/g, '/').slice(0, 60)} | ${t.category} | ${t.accountName || t.account.split('@')[0]} |`),
    '', '## Statements on file', '',
    ...ledger.statements.slice(0, 20).map((s) => `- ${s.date} — ${s.subject.replace(/\|/g, '/')} (${s.from}, ${s.account.split('@')[0]})`),
    '',
  ];
  writeFileSync(join(FIN_DIR, 'expenses.md'), lines.join('\n'));
}

/* ---------------- JARVIS voice brain ---------------- */
// Answers spoken questions. Gemini is primary; if it errors (rate limit,
// outage, quota) it automatically falls over to OpenRouter, then finally to
// an instant offline state-aware responder — whichever keys are set
// (raw HTTP — this server is zero-dependency by design).
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4.5';
const voiceHistory = []; // rolling short-term conversation memory

function stateBrief(s) {
  if (!s?.online) return 'Backend offline — no live state available.';
  const today = s.logs?.find((l) => l.log_date === new Date().toLocaleDateString('en-CA'));
  const focus = today ? [...today.content.matchAll(/^-\s*\[([ xX])\]\s*(.+)$/gm)]
    .map(([, d, t]) => `${d.trim() ? '[done]' : '[open]'} ${t}`) : [];
  return [
    `Active projects (${s.projects.length}): ${s.projects.map((p) => p.title).join('; ') || 'none'}`,
    `Open next actions (${s.actions.length}): ${s.actions.slice(0, 8).map((a) => a.description).join('; ') || 'none'}`,
    `Unprocessed inbox (${s.inbox.length}): ${s.inbox.slice(0, 8).map((i) => i.content).join('; ') || 'empty'}`,
    `Today's focus: ${focus.join('; ') || 'not set'}`,
    `Areas: ${s.areas.map((a) => `${a.name}${a.health_check ? ` (${a.health_check})` : ''}`).join('; ') || 'none'}`,
    `Recent memories: ${s.memories.slice(0, 10).map((m) => `${m.category}: ${m.content}`).join(' | ')}`,
    financeLine(),
  ].join('\n');
}

function financeLine() {
  const led = loadLedger();
  if (!led.transactions.length) return 'Finance: no transactions tracked yet.';
  const month = new Date().toLocaleDateString('en-CA').slice(0, 7);
  const t = financeTotals(led)[month];
  const last = led.transactions[0];
  return `Finance this month (${month}): spent ₹${Math.round(t?.spent || 0).toLocaleString('en-IN')}, received ₹${Math.round(t?.received || 0).toLocaleString('en-IN')} across ${t?.count || 0} transactions. Latest: ${last.type} ${last.currency === 'USD' ? '$' : '₹'}${last.amount} ${last.merchant ? `at ${last.merchant}` : `(${last.subject})`} on ${last.date}. Statements on file: ${led.statements.length}.`;
}

function jarvisSystemPrompt(context) {
  return `You are JARVIS, Deepak's personal AI operating system — calm, competent, concise, lightly witty (Iron Man's JARVIS, not a corporate chatbot). Address him as "sir" sparingly. Your answers are spoken aloud by text-to-speech, so keep them to 1-3 short sentences of plain prose: no markdown, no lists, no code. Ground answers in the live system state below; never invent facts about Deepak's life — if the state doesn't say it, say you don't know.

Current system state (${new Date().toString()}):
${context}`;
}

function recordVoiceTurn(question, answer) {
  voiceHistory.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
  while (voiceHistory.length > 12) voiceHistory.shift();
}

async function askGemini(question, context) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: jarvisSystemPrompt(context) }] },
        contents: [
          ...voiceHistory.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          { role: 'user', parts: [{ text: question }] },
        ],
        generationConfig: { maxOutputTokens: 300 },
      }),
    },
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Gemini API HTTP ${r.status}`);
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason === 'SAFETY') throw new Error('request declined');
  const answer = (candidate?.content?.parts || []).map((p) => p.text || '').join(' ').trim();
  if (!answer) throw new Error('empty answer');
  recordVoiceTurn(question, answer);
  return answer;
}

async function askOpenRouter(question, context) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      max_tokens: 300,
      messages: [
        { role: 'system', content: jarvisSystemPrompt(context) },
        ...voiceHistory,
        { role: 'user', content: question },
      ],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `OpenRouter HTTP ${r.status}`);
  const answer = data.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error('empty answer');
  recordVoiceTurn(question, answer);
  return answer;
}

function localBrain(question, s) {
  const q = question.toLowerCase();
  const now = new Date();
  const online = !!s?.online;
  const focusItems = () => {
    const today = s.logs?.find((l) => l.log_date === now.toLocaleDateString('en-CA'));
    return today ? [...today.content.matchAll(/^-\s*\[[ ]\]\s*(.+)$/gm)].map((m) => m[1]) : [];
  };
  if (/\b(time|clock)\b/.test(q)) return `It is ${now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}, sir.`;
  if (/\b(date|day)\b/.test(q)) return `Today is ${now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`;
  if (/\b(hello|hi|hey|good (morning|afternoon|evening)|jarvis)\b/.test(q) && q.length < 40) {
    return online
      ? `At your service, sir. ${s.inbox.length ? `${s.inbox.length} item${s.inbox.length > 1 ? 's' : ''} in the inbox, ` : 'Inbox is clear, '}${s.projects.length} active project${s.projects.length === 1 ? '' : 's'}.`
      : 'At your service, sir — though the backend is offline at the moment.';
  }
  if (!online) return 'The backend is offline, sir — I can only tell you the time and date until it returns.';
  if (/\b(focus|today|priorit)/.test(q)) {
    const f = focusItems();
    return f.length ? `Today's focus: ${f.join('. Also, ')}.` : 'No focus set for today yet — say the word and I shall note one down.';
  }
  if (/\binbox\b/.test(q)) {
    return s.inbox.length
      ? `${s.inbox.length} unprocessed item${s.inbox.length > 1 ? 's' : ''}: ${s.inbox.slice(0, 3).map((i) => i.content).join('. Next, ')}.`
      : 'Inbox zero, sir. Immaculate.';
  }
  if (/\bproject/.test(q)) {
    return s.projects.length
      ? `${s.projects.length} active project${s.projects.length > 1 ? 's' : ''}: ${s.projects.map((p) => p.title).join(', ')}.`
      : 'No active projects at present — a rare moment of calm.';
  }
  if (/\b(action|task|todo|to do)\b/.test(q)) {
    return s.actions.length
      ? `${s.actions.length} open action${s.actions.length > 1 ? 's' : ''}. First up: ${s.actions[0].description}.`
      : 'No open next actions, sir.';
  }
  if (/\b(spen[dt]|expense|expenses|transaction|money|paid|balance)\b/.test(q)) {
    const led = loadLedger();
    if (!led.transactions.length) return 'No transactions tracked yet, sir — hit scan in the Finance panel and I shall read your bank mail.';
    const month = now.toLocaleDateString('en-CA').slice(0, 7);
    const t = financeTotals(led)[month];
    const last = led.transactions[0];
    return `This month I've tracked ${t?.count || 0} transactions — ₹${Math.round(t?.spent || 0).toLocaleString('en-IN')} out, ₹${Math.round(t?.received || 0).toLocaleString('en-IN')} in. Most recent: ${last.type} of ₹${last.amount.toLocaleString('en-IN')}${last.merchant ? ` at ${last.merchant}` : ''} on ${last.date}.`;
  }
  if (/\b(status|report|brief|summary|what.s up)\b/.test(q)) {
    return `All systems nominal. ${s.projects.length} project${s.projects.length === 1 ? '' : 's'}, ${s.actions.length} open actions, ${s.inbox.length} in the inbox, ${s.memories.length} memories on file.`;
  }
  return 'I heard you, sir, but my full intelligence is offline — add a GEMINI_API_KEY or OPENROUTER_API_KEY to Apps/hud/.env and I shall answer anything. For now, ask me about your focus, inbox, projects, or the time.';
}

async function askJarvis(question) {
  let s = null;
  try { s = await state(); } catch { /* offline */ }
  const context = stateBrief(s);
  if (GEMINI_KEY) {
    try { return { answer: await askGemini(question, context), source: 'gemini' }; }
    catch (e) { console.warn('gemini fallback:', e.message); }
  }
  if (OPENROUTER_KEY) {
    try { return { answer: await askOpenRouter(question, context), source: 'openrouter' }; }
    catch (e) { console.warn('openrouter fallback:', e.message); }
  }
  return { answer: localBrain(question, s), source: 'local' };
}

/* ---------------- Gmail (read-only, multi-account) ---------------- */
const GMAIL_TOKENS_FILE = join(__dirname, '.gmail-tokens.json'); // { "email": {tokens} }

function tokenStore() { try { return JSON.parse(readFileSync(GMAIL_TOKENS_FILE, 'utf8')); } catch { return {}; } }
function saveTokenStore(store) { writeFileSync(GMAIL_TOKENS_FILE, JSON.stringify(store, null, 2)); }
function gmailStatus() {
  return { configured: !!(GOOGLE_ID && GOOGLE_SECRET), accounts: Object.keys(tokenStore()),
           connected: Object.keys(tokenStore()).length > 0 };
}

function gmailAuthUrl() {
  const p = new URLSearchParams({
    client_id: GOOGLE_ID, redirect_uri: REDIRECT_URI, response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline', prompt: 'consent select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function gmailProfileEmail(accessToken) {
  const p = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile',
    { headers: { Authorization: `Bearer ${accessToken}` } })).json();
  if (!p.emailAddress) throw new Error(`could not resolve account email: ${JSON.stringify(p)}`);
  return p.emailAddress;
}

async function gmailExchange(code) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: GOOGLE_ID, client_secret: GOOGLE_SECRET,
      redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
    }),
  });
  const tok = await r.json();
  if (!r.ok || !tok.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tok)}`);
  tok.expiry = Date.now() + (tok.expires_in || 3600) * 1000;
  const email = await gmailProfileEmail(tok.access_token);
  const store = tokenStore();
  // keep an existing refresh_token if Google didn't reissue one
  store[email] = { ...store[email], ...tok };
  saveTokenStore(store);
  return email;
}

async function gmailAccessToken(email) {
  const store = tokenStore();
  let tok = store[email];
  if (!tok) throw new Error(`${email} not connected`);
  if (Date.now() > (tok.expiry || 0) - 60000 && tok.refresh_token) {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: tok.refresh_token, client_id: GOOGLE_ID,
        client_secret: GOOGLE_SECRET, grant_type: 'refresh_token',
      }),
    });
    const fresh = await r.json();
    if (!r.ok || !fresh.access_token) throw new Error(`${email}: token refresh failed — reconnect`);
    tok = { ...tok, ...fresh, expiry: Date.now() + (fresh.expires_in || 3600) * 1000 };
    store[email] = tok;
    saveTokenStore(store);
  }
  return tok.access_token;
}

async function gmailRecentFor(email, max = 10) {
  const at = await gmailAccessToken(email);
  const gh = { Authorization: `Bearer ${at}` };
  const list = await (await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&labelIds=INBOX`, { headers: gh })).json();
  if (list.error) throw new Error(list.error.message);
  return Promise.all((list.messages || []).map(async ({ id }) => {
    const m = await (await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: gh })).json();
    const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
    return {
      id, account: email,
      from: (h.from || '').replace(/\s*<.*>/, ''), subject: h.subject || '(no subject)',
      date: h.date || '', ts: Number(m.internalDate || 0),
      snippet: m.snippet || '', unread: (m.labelIds || []).includes('UNREAD'),
    };
  }));
}

async function gmailRecent(account) {
  const emails = account ? [account] : Object.keys(tokenStore());
  if (!emails.length) throw new Error('gmail not connected');
  const results = await Promise.allSettled(emails.map((e) => gmailRecentFor(e)));
  const msgs = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const errors = results
    .map((r, i) => (r.status === 'rejected' ? `${emails[i]}: ${r.reason?.message || r.reason}` : null))
    .filter(Boolean);
  msgs.sort((a, b) => b.ts - a.ts);
  return { messages: msgs.slice(0, 15), errors };
}

// migrate the old single-account token file into the store on boot
(async () => {
  if (!existsSync(GMAIL_TOKEN_FILE)) return;
  try {
    const legacy = JSON.parse(readFileSync(GMAIL_TOKEN_FILE, 'utf8'));
    const email = await gmailProfileEmail(legacy.access_token).catch(async () => {
      // access token stale — refresh via the legacy refresh_token first
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: legacy.refresh_token, client_id: GOOGLE_ID,
          client_secret: GOOGLE_SECRET, grant_type: 'refresh_token',
        }),
      });
      const fresh = await r.json();
      if (!fresh.access_token) throw new Error('legacy token dead');
      Object.assign(legacy, fresh, { expiry: Date.now() + (fresh.expires_in || 3600) * 1000 });
      return gmailProfileEmail(legacy.access_token);
    });
    const store = tokenStore();
    if (!store[email]) { store[email] = legacy; saveTokenStore(store); }
    const { unlinkSync } = await import('node:fs');
    unlinkSync(GMAIL_TOKEN_FILE);
    console.log(`migrated legacy gmail token → ${email}`);
  } catch (e) { console.warn('legacy gmail token migration skipped:', e.message); }
})();

/* ---------------- HTTP plumbing ---------------- */
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

// Auth for /api/* — when HUD_TOKEN is set, require it via `Authorization: Bearer <token>`
// or `?token=<token>`. Loopback callers (127.0.0.1 / ::1) are trusted so the local
// browser HUD keeps working without configuration.
const HUD_TOKEN = process.env.HUD_TOKEN || '';
const isLoopback = (req) => {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};
const authorized = (req, url) => {
  if (isLoopback(req)) return true;
  if (!HUD_TOKEN) return false; // non-loopback + no token configured → deny
  const hdr = req.headers['authorization'] || '';
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  const token = bearer || url.searchParams.get('token') || '';
  return token && token === HUD_TOKEN;
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = `${req.method} ${url.pathname}`;
  try {
    // Gate every /api/* route. Static assets (HUD frontend) remain public so the
    // local browser can load the shell; API calls from that shell are on loopback.
    if (url.pathname.startsWith('/api/') && !authorized(req, url)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    /* ---- API ---- */
    if (route === 'GET /api/state') {
      try { return json(res, 200, await state()); }
      catch (e) { return json(res, 200, localState(String(e.message || e))); }
    }
    if (route === 'POST /api/inbox') {
      const { content } = await readBody(req);
      if (!content?.trim()) return json(res, 400, { error: 'content required' });
      await captureInbox(content.trim());
      return json(res, 200, { ok: true });
    }
    if (route === 'POST /api/inbox/process') {
      const { id } = await readBody(req);
      if (!id) return json(res, 400, { error: 'id required' });
      await processInbox(id);
      return json(res, 200, { ok: true });
    }
    if (route === 'POST /api/focus') {
      const { text } = await readBody(req);
      if (!text?.trim()) return json(res, 400, { error: 'text required' });
      await addFocus(text.trim());
      return json(res, 200, { ok: true });
    }
    if (route === 'POST /api/focus/toggle') {
      const { text, done } = await readBody(req);
      if (!text) return json(res, 400, { error: 'text required' });
      await toggleFocus(text, !!done);
      return json(res, 200, { ok: true });
    }
    if (route === 'GET /api/finance') {
      const ledger = loadLedger();
      const profile = loadFinProfile();
      return json(res, 200, {
        ok: true, ...ledger, transactions: decorateTransactions(ledger, profile),
        totals: financeTotals(ledger), profile, categories: CATEGORIES,
      });
    }
    if (route === 'POST /api/finance/scan') {
      if (!gmailStatus().connected) return json(res, 400, { error: 'no Gmail account connected' });
      const { ledger, added, errors } = await scanFinance();
      const profile = loadFinProfile();
      return json(res, 200, {
        ok: true, ...ledger, transactions: decorateTransactions(ledger, profile),
        added, errors, totals: financeTotals(ledger), profile, categories: CATEGORIES,
      });
    }
    if (route === 'POST /api/finance/accounts') {
      const { op, id, account } = await readBody(req);
      const profile = loadFinProfile();
      if (op === 'add') {
        if (!account?.name?.trim() || !account?.type) return json(res, 400, { error: 'account name and type required' });
        if (account.last4 && !/^\d{4}$/.test(account.last4)) return json(res, 400, { error: 'last4 must be exactly 4 digits' });
        profile.accounts.push({
          id: crypto.randomUUID(), type: account.type, name: account.name.trim(),
          institution: account.institution?.trim() || '', last4: account.last4 || '', note: account.note?.trim() || '',
        });
      } else if (op === 'delete') {
        profile.accounts = profile.accounts.filter((a) => a.id !== id);
      } else return json(res, 400, { error: 'unknown op' });
      await saveFinProfile(profile);
      return json(res, 200, { ok: true, profile });
    }
    if (route === 'POST /api/finance/goals') {
      const { op, id, goal, saved } = await readBody(req);
      const profile = loadFinProfile();
      if (op === 'add') {
        if (!goal?.title?.trim() || !(Number(goal.target) > 0)) return json(res, 400, { error: 'goal title and target amount required' });
        profile.goals.push({
          id: crypto.randomUUID(), title: goal.title.trim(),
          target: Number(goal.target), saved: Number(goal.saved) || 0, deadline: goal.deadline || '',
        });
      } else if (op === 'update') {
        const g = profile.goals.find((x) => x.id === id);
        if (!g) return json(res, 400, { error: 'goal not found' });
        g.saved = Math.max(0, Number(saved) || 0);
      } else if (op === 'delete') {
        profile.goals = profile.goals.filter((g) => g.id !== id);
      } else return json(res, 400, { error: 'unknown op' });
      await saveFinProfile(profile);
      return json(res, 200, { ok: true, profile });
    }
    if (route === 'POST /api/finance/categorize') {
      const { id, category, match } = await readBody(req);
      if (!id || !CATEGORIES.includes(category)) return json(res, 400, { error: 'transaction id and valid category required' });
      const profile = loadFinProfile();
      profile.overrides[id] = category;
      if (match?.trim()) {
        const m = match.trim().toLowerCase();
        profile.rules = profile.rules.filter((r) => r.match !== m);
        profile.rules.push({ match: m, category });
      }
      await saveFinProfile(profile);
      const ledger = loadLedger();
      await writeExpensesMd(ledger);
      return json(res, 200, { ok: true, transactions: decorateTransactions(ledger, profile), profile });
    }
    if (route === 'POST /api/jarvis') {
      const { question } = await readBody(req);
      if (!question?.trim()) return json(res, 400, { error: 'question required' });
      const t0 = Date.now();
      const { answer, source } = await askJarvis(question.trim());
      return json(res, 200, { ok: true, answer, source, ms: Date.now() - t0 });
    }
    if (route === 'GET /api/settings') return json(res, 200, loadSettings());
    if (route === 'POST /api/settings') return json(res, 200, saveSettings(await readBody(req)));
    if (route === 'POST /api/projects') {
      const { title, outcome, firstAction } = await readBody(req);
      if (!title?.trim()) return json(res, 400, { error: 'title required' });
      const proj = await createProject({ title: title.trim(), outcome: outcome?.trim(), firstAction: firstAction?.trim() });
      return json(res, 200, { ok: true, project: proj });
    }
    if (route === 'POST /api/actions/done') {
      const { id } = await readBody(req);
      if (!id) return json(res, 400, { error: 'id required' });
      await completeAction(id);
      return json(res, 200, { ok: true });
    }
    if (route === 'POST /api/areas') {
      const { name, health } = await readBody(req);
      if (!name || !health?.trim()) return json(res, 400, { error: 'name and health required' });
      await updateArea(name, health.trim());
      return json(res, 200, { ok: true });
    }
    if (route === 'POST /api/memories') {
      const { category, content } = await readBody(req);
      if (!content?.trim()) return json(res, 400, { error: 'content required' });
      await addMemory(category || 'notes', content.trim());
      return json(res, 200, { ok: true });
    }
    /* ---- Gmail ---- */
    if (route === 'GET /api/gmail/connect') {
      if (!GOOGLE_ID || !GOOGLE_SECRET) return json(res, 400, { error: 'Gmail not configured — set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in Apps/hud/.env' });
      return json(res, 200, { url: gmailAuthUrl() });
    }
    if (route === 'GET /api/gmail/callback') {
      const code = url.searchParams.get('code');
      if (!code) { res.writeHead(400); return res.end('missing code'); }
      await gmailExchange(code);
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    if (route === 'GET /api/gmail/messages') {
      try {
        const { messages, errors } = await gmailRecent(url.searchParams.get('account') || undefined);
        return json(res, 200, { ok: true, messages, errors, accounts: Object.keys(tokenStore()) });
      } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (route === 'POST /api/gmail/disconnect') {
      const { email } = await readBody(req);
      const store = tokenStore();
      if (!email || !store[email]) return json(res, 400, { error: 'unknown account' });
      delete store[email];
      saveTokenStore(store);
      return json(res, 200, { ok: true, accounts: Object.keys(store) });
    }
    /* ---- static (SPA fallback: unknown non-asset paths serve index.html) ---- */
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = normalize(file).replace(/^([.][.][/\\])+/, '');
    let full = join(PUBLIC_DIR, file);
    const hasExt = !!extname(file);
    if (!full.startsWith(PUBLIC_DIR) || !existsSync(full)) {
      if (hasExt) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
      }
      full = join(PUBLIC_DIR, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' });
    return res.end(readFileSync(full));
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, () => {
  console.log(`JARVIS HUD online at http://localhost:${PORT}`);
  if (!SUPABASE_URL || !KEY) console.warn('WARNING: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — /api/state will report offline');
});
