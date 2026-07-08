// JARVIS HUD frontend — one-screen 3D control panel.
// Views: HUD (focus/projects/inbox/mail) + Settings (connections/display/system data).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const daysAgo = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

let SETTINGS = { accent: "#35d6ed", refreshSeconds: 30, panels: { focus: true, projects: true, finance: true, inbox: true, mail: true } };
let refreshTimer;

/* ---------- clock & date ---------- */
function tickClock() {
  const now = new Date();
  $("clock").textContent = now.toLocaleTimeString("en-IN", { hour12: false });
  $("bigDate").textContent = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }).toUpperCase();
  $("bigDay").textContent = now.toLocaleDateString("en-IN", { weekday: "long" });
}
setInterval(tickClock, 1000); tickClock();

/* ---------- toast + API ---------- */
let toastTimer;
function toast(msg, kind = "ok") {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), 2600);
}
async function api(path, body) {
  const r = await fetch(path, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/* ---------- settings ---------- */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}
const ACCENTS = ["#35d6ed", "#ff4d4d", "#4ade80", "#fbbf24"];

function applySettings() {
  document.documentElement.style.setProperty("--accent", SETTINGS.accent);
  document.documentElement.style.setProperty("--accent-rgb", hexToRgb(SETTINGS.accent));
  window.dispatchEvent(new CustomEvent("accent:changed", { detail: SETTINGS.accent }));
  for (const [key, on] of Object.entries(SETTINGS.panels)) {
    document.querySelector(`[data-panel="${key}"]`)?.toggleAttribute("hidden", !on);
  }
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, Math.max(10, SETTINGS.refreshSeconds) * 1000);
  renderSettingsControls();
}
async function saveSettings(patch) {
  SETTINGS = await api("api/settings", patch);
  applySettings();
}

function renderSettingsControls() {
  $("panelToggles").innerHTML = Object.entries(SETTINGS.panels).map(([k, on]) => `
    <button class="toggle ${on ? "on" : ""}" data-toggle="${k}"><span class="dot"></span>${k}</button>`).join("");
  $("refreshChips").innerHTML = [10, 30, 60].map((s) => `
    <button class="chip ${SETTINGS.refreshSeconds === s ? "active" : ""}" data-interval="${s}">${s}s</button>`).join("");
  $("accentChips").innerHTML = ACCENTS.map((c) => `
    <button class="swatch ${SETTINGS.accent === c ? "active" : ""}" data-accent="${c}" style="background:${c}" title="${c}"></button>`).join("");
}

/* ---------- view toggle: hud | settings | finance ---------- */
function setView(name) {
  document.body.classList.toggle("settings", name === "settings");
  $("hudView").hidden = name !== "hud";
  $("settingsView").hidden = name !== "settings";
  $("financeView").hidden = name !== "finance";
  if (name === "finance") renderFinanceView();
}

/* ---------- panel tilt (CSS 3D) — cached nodes, one update per frame ---------- */
let tiltNodes = [...document.querySelectorAll(".tilt")];
let tiltEvent = null, tiltRaf = 0, tiltActive = null;
function applyTilt() {
  tiltRaf = 0;
  const e = tiltEvent;
  const el = e && e.target.closest?.(".tilt");
  if (tiltActive && tiltActive !== el) tiltActive.style.transform = "";
  tiltActive = el;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const rx = ((e.clientY - r.top) / r.height - 0.5) * -4;
  const ry = ((e.clientX - r.left) / r.width - 0.5) * 4;
  el.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateZ(6px)`;
}
document.addEventListener("pointermove", (e) => {
  tiltEvent = e;
  if (!tiltRaf) tiltRaf = requestAnimationFrame(applyTilt);
}, { passive: true });
document.addEventListener("pointerleave", () => {
  tiltNodes.forEach((p) => (p.style.transform = ""));
  tiltActive = null;
}, true);

/* ---------- voice: click JARVIS, speak, get an answer ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let voiceState = "idle"; // idle | listening | thinking | speaking
let recognizer = null, speakTimer = null;

function setVoiceState(state, statusText) {
  voiceState = state;
  document.body.dataset.voice = state;
  $("voiceStatus").textContent = statusText ?? { idle: "", listening: "◉ listening…", thinking: "◌ processing…", speaking: "▸ speaking" }[state];
  window.dispatchEvent(new CustomEvent("voice:state", { detail: state }));
}

let cachedVoice;
function jarvisVoice() {
  if (cachedVoice) return cachedVoice;
  const voices = speechSynthesis.getVoices();
  const prefer = ["Google UK English Male", "Daniel", "Ryan", "George", "Microsoft Ryan Online (Natural) - English (United Kingdom)"];
  cachedVoice = prefer.map((n) => voices.find((v) => v.name.includes(n))).find(Boolean)
    || voices.find((v) => v.lang === "en-GB") || voices.find((v) => v.lang.startsWith("en")) || null;
  return cachedVoice;
}
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => (cachedVoice = null);

function speak(text) {
  if (!("speechSynthesis" in window)) return setVoiceState("idle");
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = jarvisVoice();
  if (v) u.voice = v;
  u.rate = 1.04; u.pitch = 0.92;
  u.onend = u.onerror = () => setVoiceState("idle");
  setVoiceState("speaking");
  speechSynthesis.speak(u);
}

function typeOut(el, text) {
  el.textContent = "";
  el.classList.add("typing");
  let i = 0;
  clearInterval(speakTimer);
  speakTimer = setInterval(() => {
    el.textContent = text.slice(0, ++i);
    if (i >= text.length) { clearInterval(speakTimer); el.classList.remove("typing"); }
  }, 14);
}

async function askJarvis(question) {
  const console_ = $("voiceConsole");
  console_.hidden = false;
  $("voiceYou").textContent = `» ${question}`;
  $("voiceAnswer").textContent = "";
  setVoiceState("thinking");
  try {
    const { answer } = await api("api/jarvis", { question });
    typeOut($("voiceAnswer"), answer);
    speak(answer);
  } catch (e) {
    setVoiceState("idle");
    $("voiceAnswer").textContent = `⚠ ${e.message}`;
  }
}

function toggleVoice() {
  if (voiceState === "listening") { recognizer?.stop(); return; }
  if (voiceState === "speaking") { speechSynthesis.cancel(); setVoiceState("idle"); return; }
  if (voiceState === "thinking") return;
  if (!SR) { toast("Voice input needs Chrome or Edge (Web Speech API)", "err"); return; }
  recognizer = new SR();
  recognizer.lang = "en-IN";
  recognizer.interimResults = true;
  recognizer.maxAlternatives = 1;
  let transcript = "";
  setVoiceState("listening");
  $("voiceConsole").hidden = false;
  $("voiceAnswer").textContent = "";
  $("voiceYou").textContent = "» …";
  recognizer.onresult = (ev) => {
    transcript = [...ev.results].map((r) => r[0].transcript).join(" ").trim();
    $("voiceYou").textContent = `» ${transcript}`;
  };
  recognizer.onerror = (ev) => {
    setVoiceState("idle");
    if (ev.error === "not-allowed") toast("Microphone blocked — allow mic access for localhost", "err");
    else if (ev.error !== "aborted" && ev.error !== "no-speech") toast(`voice error: ${ev.error}`, "err");
    if (ev.error === "no-speech") $("voiceYou").textContent = "» (heard nothing, sir)";
  };
  recognizer.onend = () => {
    if (voiceState !== "listening") return;
    if (transcript) askJarvis(transcript);
    else setVoiceState("idle");
  };
  try { recognizer.start(); } catch { setVoiceState("idle"); }
}

/* ---------- renderers ---------- */
function renderFocus(logs) {
  const today = new Date().toLocaleDateString("en-CA");
  const todayLog = logs.find((l) => l.log_date === today);
  const el = $("focusList");
  const section = todayLog ? (todayLog.content.split(/^##\s*Today'?s Focus\s*$/mi)[1] || "") : "";
  const items = [...section.matchAll(/^-\s*\[([ xX])\]\s*(.+)$/gm)];
  if (!items.length) { el.innerHTML = '<li class="empty">No focus set — run /brief or add one below</li>'; return; }
  el.innerHTML = items.map(([, done, text]) => {
    const isDone = done.trim().toLowerCase() === "x";
    return `<li class="${isDone ? "done" : ""} clickable" data-text="${esc(text)}" data-done="${isDone}" title="Click to toggle">
      <span class="box">${isDone ? "◉" : "◯"}</span><span>${esc(text)}</span></li>`;
  }).join("");
}

function renderProjects(projects, actions) {
  $("projectCount").textContent = projects.length ? `· ${projects.length}` : "";
  const el = $("projectList");
  if (!projects.length) { el.innerHTML = '<div class="empty">No active projects — hit “+ new”</div>'; return; }
  el.innerHTML = projects.map((p) => {
    const acts = actions.filter((a) => a.project_id === p.id);
    const stale = daysAgo(p.updated_at) > 14;
    return `<div class="project">
      <div class="project-name">${esc(p.title)}<span class="badge">${esc(p.status)}</span></div>
      ${acts.length
        ? acts.slice(0, 3).map((a) => `<div class="project-meta action-item" data-action="${esc(a.id)}" title="Click to complete">◯ ${esc(a.description)}</div>`).join("")
        : '<div class="project-meta stale">⚠ no next action</div>'}
      ${stale ? '<div class="project-meta stale">⚠ stale — untouched 14+ days</div>' : ""}
    </div>`;
  }).join("");
}

function renderLog(logs) {
  const el = $("logLines");
  if (!logs.length) { el.innerHTML = '<div class="empty">No log entries</div>'; return; }
  el.innerHTML = logs.map((l) => {
    const bullets = [...l.content.matchAll(/^-\s+(.+)$/gm)].map((m) => m[1]);
    return `<div class="log-date">${esc(l.log_date)}</div>` +
      bullets.map((b) => `<div>· ${esc(b.replace(/\[.\]\s*/, ""))}</div>`).join("");
  }).join("");
}

function renderInbox(inbox) {
  $("inboxCount").textContent = inbox.length ? `· ${inbox.length}` : "";
  const el = $("inboxList");
  if (!inbox.length) { el.innerHTML = '<li class="empty">Inbox zero. Immaculate, sir.</li>'; return; }
  el.innerHTML = inbox.map((i) =>
    `<li><span>${esc(i.content)}</span><span class="when">${esc(i.captured_on)}</span>
     <button class="mini-btn done-btn" data-id="${esc(i.id)}" title="Mark processed">✓</button></li>`).join("");
}

function renderAreas(areas) {
  $("areaList").innerHTML = areas.map((a) => {
    const health = a.health_check;
    return `<li><span class="area-name">${esc(a.name)}</span>
      <span class="area-health ${health ? "" : "unreviewed"}" data-area="${esc(a.name)}" title="Click to edit">${esc(health || "not yet reviewed")}</span></li>`;
  }).join("");
}

function renderMemory(memories) {
  $("memoryCount").textContent = memories.length ? `· ${memories.length}` : "";
  const el = $("memoryList");
  if (!memories.length) { el.innerHTML = '<li class="empty">Nothing remembered yet</li>'; return; }
  el.innerHTML = memories.slice(0, 20).map((m) =>
    `<li><span class="cat">${esc(m.category)}</span>${esc(m.content.length > 90 ? m.content.slice(0, 90) + "…" : m.content)}</li>`).join("");
}

/* ---------- finance ---------- */
const inr = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;
let FIN = null;           // last /api/finance payload
let finFilter = "";       // active category filter in the finance view
const ACCT_ICON = { bank: "🏦", credit_card: "💳", loan: "📉" };
const ACCT_LABEL = { bank: "bank", credit_card: "card", loan: "loan" };

async function loadFinance(scan = false) {
  const sum = $("finSummary");
  try {
    if (scan) sum.innerHTML = '<span class="empty">scanning transaction mail…</span>';
    FIN = await api(scan ? "api/finance/scan" : "api/finance", scan ? {} : undefined);
    if (scan) toast(FIN.added ? `${FIN.added} new transaction${FIN.added > 1 ? "s" : ""} tracked` : "No new transactions");
    renderFinancePanel();
    if (!$("financeView").hidden) renderFinanceView();
  } catch (e) {
    sum.innerHTML = `<span class="empty">⚠ ${esc(e.message)}</span>`;
  }
}

function renderFinancePanel() {
  if (!FIN) return;
  const list = $("finList"), sum = $("finSummary");
  const month = new Date().toLocaleDateString("en-CA").slice(0, 7);
  const t = FIN.totals?.[month];
  $("finCount").textContent = FIN.transactions.length ? `· ${FIN.transactions.length}` : "";
  sum.innerHTML = FIN.transactions.length
    ? `<span class="fin-chip out">▼ ${inr(t?.spent || 0)} out</span>
       <span class="fin-chip in">▲ ${inr(t?.received || 0)} in</span>
       <span class="fin-chip">${t?.count || 0} txns this month</span>
       <span class="fin-chip">${FIN.statements.length} statements</span>`
    : '<span class="empty">no transactions tracked yet</span>';
  if (FIN.errors?.length) sum.innerHTML += FIN.errors.map((e) => `<span class="empty">⚠ ${esc(e)}</span>`).join("");
  const multi = new Set(FIN.transactions.map((x) => x.account)).size > 1;
  list.innerHTML = FIN.transactions.length
    ? FIN.transactions.slice(0, 40).map((x) => `
      <li data-mail="${esc(x.id)}" data-mailacct="${esc(x.account)}" title="${esc(x.subject)} — open in Gmail">
        <span class="amt ${x.type}">${x.type === "debit" ? "−" : "+"}${x.currency === "USD" ? "$" : "₹"}${x.amount.toLocaleString("en-IN")}</span>
        <span class="fin-what">${multi ? `<span class="acct-tag">${esc(x.account.split("@")[0])}</span>` : ""}${esc(x.merchant || x.from || x.subject)}</span>
        <span class="when">${esc(x.date.slice(5))}</span>
      </li>`).join("")
    : '<li class="empty">Hit “↻ scan” to read transaction mail</li>';
}

function renderFinanceView() {
  if (!FIN) return;
  const p = FIN.profile;
  const month = new Date().toLocaleDateString("en-CA").slice(0, 7);

  /* accounts / cards / loans */
  $("acctCount").textContent = p.accounts.length ? `· ${p.accounts.length}` : "";
  $("acctList").innerHTML = p.accounts.length
    ? p.accounts.map((a) => `
      <div class="acct-row">
        <span class="acct-icon">${ACCT_ICON[a.type] || "•"}</span>
        <span class="acct-main"><b>${esc(a.name)}</b>
          <span class="acct-sub">${esc(a.institution || ACCT_LABEL[a.type] || "")}${a.last4 ? ` ··${esc(a.last4)}` : ""}</span></span>
        <button class="chip-x" data-del-acct="${esc(a.id)}" title="Remove ${esc(a.name)}">×</button>
      </div>`).join("")
    : '<div class="empty">Nothing registered yet — add your banks, cards and loans below. The last-4 digits let me pin transactions to the right account.</div>';

  /* goals */
  $("goalCount").textContent = p.goals.length ? `· ${p.goals.length}` : "";
  $("goalList").innerHTML = p.goals.length
    ? p.goals.map((g) => {
      const pct = Math.min(100, Math.round((g.saved / g.target) * 100));
      return `<li class="goal">
        <div class="goal-top"><span>${esc(g.title)}</span>
          <span class="goal-nums"><b class="goal-saved" data-goal="${esc(g.id)}" title="Click to update saved amount">${inr(g.saved)}</b> / ${inr(g.target)}</span>
          <button class="chip-x" data-del-goal="${esc(g.id)}" title="Remove goal">×</button></div>
        <div class="goal-bar"><div class="goal-fill" style="width:${pct}%"></div></div>
        <div class="goal-meta">${pct}%${g.deadline ? ` · by ${esc(g.deadline)}` : ""}</div>
      </li>`;
    }).join("")
    : '<li class="empty">No goals yet — give me a target, sir</li>';

  /* category bars for current month */
  const byCat = {};
  for (const t of FIN.transactions) {
    if (t.date.startsWith(month) && t.type === "debit" && t.currency === "INR") byCat[t.category] = (byCat[t.category] || 0) + t.amount;
  }
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const max = cats[0]?.[1] || 1;
  $("catBars").innerHTML = cats.length
    ? cats.map(([c, v]) => `
      <div class="cat-row" data-cat-filter="${esc(c)}" title="Filter transactions: ${esc(c)}">
        <span class="cat-name">${esc(c)}</span>
        <div class="cat-track"><div class="cat-fill" style="width:${Math.max(3, Math.round((v / max) * 100))}%"></div></div>
        <span class="cat-amt">${inr(v)}</span>
      </div>`).join("")
    : '<div class="empty">No spends tracked this month</div>';

  /* statements */
  $("stCount").textContent = FIN.statements.length ? `· ${FIN.statements.length}` : "";
  $("stList").innerHTML = FIN.statements.length
    ? `<ul class="mail-list">` + FIN.statements.slice(0, 30).map((s) => `
      <li data-mail="${esc(s.id)}" data-mailacct="${esc(s.account)}" title="Open in Gmail">
        <div class="mail-top"><span class="mail-from">${esc(s.from)}</span><span class="when">${esc(s.date)}</span></div>
        <div class="mail-subject">${esc(s.subject)}</div>
      </li>`).join("") + `</ul>`
    : '<div class="empty">No statements found yet — hit scan</div>';

  /* transaction ledger with category filter */
  const filtered = finFilter ? FIN.transactions.filter((t) => t.category === finFilter) : FIN.transactions;
  $("txCount").textContent = `· ${filtered.length}`;
  const usedCats = [...new Set(FIN.transactions.map((t) => t.category))];
  $("catFilter").innerHTML = [`<button class="chip ${finFilter === "" ? "active" : ""}" data-cat-filter="">all</button>`,
    ...usedCats.map((c) => `<button class="chip ${finFilter === c ? "active" : ""}" data-cat-filter="${esc(c)}">${esc(c.split(" ")[0].toLowerCase())}</button>`)].join("");
  $("txFullList").innerHTML = filtered.length
    ? filtered.slice(0, 120).map((x) => `
      <li>
        <span class="amt ${x.type}">${x.type === "debit" ? "−" : "+"}${x.currency === "USD" ? "$" : "₹"}${x.amount.toLocaleString("en-IN")}</span>
        <span class="fin-what" data-mail="${esc(x.id)}" data-mailacct="${esc(x.account)}" title="${esc(x.subject)} — open in Gmail">
          ${esc(x.merchant || x.from || x.subject)}${x.accountName ? `<span class="acct-tag">${esc(x.accountName)}</span>` : ""}</span>
        <button class="cat-chip" data-tx="${esc(x.id)}" data-merchant="${esc(x.merchant || "")}" title="Click to correct the category">${esc(x.category)}</button>
        <span class="when">${esc(x.date.slice(5))}</span>
      </li>`).join("")
    : '<li class="empty">Nothing in this category yet</li>';
}

function openCategoryPicker(chip) {
  const current = chip.textContent;
  const sel = document.createElement("select");
  sel.className = "cat-select";
  sel.innerHTML = FIN.categories.map((c) => `<option ${c === current ? "selected" : ""}>${c}</option>`).join("");
  chip.replaceWith(sel);
  sel.focus();
  const commit = async () => {
    try {
      if (sel.value !== current) {
        await api("api/finance/categorize", { id: sel.dataset.tx || chip.dataset.tx, category: sel.value, match: chip.dataset.merchant });
        toast(`Filed under ${sel.value}${chip.dataset.merchant ? " — rule saved" : ""}`);
        await loadFinance();
      } else renderFinanceView();
    } catch (e) { toast(e.message, "err"); renderFinanceView(); }
  };
  sel.addEventListener("change", commit);
  sel.addEventListener("blur", () => { if (!sel.dataset.done) renderFinanceView(); }, { once: true });
  sel.addEventListener("change", () => (sel.dataset.done = "1"));
}

/* ---------- gmail ---------- */
let mailAccount = "";
let mailUnread = 0;
const accountTag = (email) => esc(email.split("@")[0]);

function renderGmailSettings(gmail) {
  const el = $("gmailAccounts");
  if (!gmail?.configured) {
    el.innerHTML = `<div class="empty">Not configured — add <code>GOOGLE_CLIENT_ID</code> / <code>GOOGLE_CLIENT_SECRET</code> to <code>Apps/hud/.env</code> and restart.</div>`;
    return;
  }
  el.innerHTML = `<div class="chip-row">${(gmail.accounts || []).map((a) => `
    <span class="chip-group">
      <span class="chip active" title="${esc(a)}">${accountTag(a)}</span>
      <button class="chip-x" data-disconnect="${esc(a)}" title="Disconnect ${esc(a)}">×</button>
    </span>`).join("")}
    <button class="chip chip-add" id="gmailAdd">+ add account</button></div>
    <div class="empty">if blocked in an embedded preview, open <code>http://localhost:3960</code> in a browser</div>`;
}

function renderGmail(gmail) {
  const body = $("gmailBody");
  $("mailRefresh").hidden = !gmail?.connected;
  renderGmailSettings(gmail);
  if (!gmail?.configured) { body.innerHTML = '<div class="empty">Gmail not configured — see Settings ⚙</div>'; return; }
  if (!gmail.connected) { body.innerHTML = '<button class="connect-btn" id="gmailConnect">Connect Gmail</button>'; return; }
  if (!body.dataset.loaded) loadMail();
}

async function loadMail() {
  const body = $("gmailBody");
  body.dataset.loaded = "1";
  body.innerHTML = '<div class="empty">fetching mail…</div>';
  try {
    const { ok, messages, errors, accounts, error } = await api(`api/gmail/messages${mailAccount ? `?account=${encodeURIComponent(mailAccount)}` : ""}`);
    if (!ok) throw new Error(error);
    mailUnread = messages.filter((m) => m.unread).length;
    $("statMail").textContent = mailUnread;
    $("mailCount").textContent = messages.length ? `· ${messages.length}` : "";
    const chips = accounts.length > 1 ? `<div class="chip-row">
      <button class="chip ${mailAccount === "" ? "active" : ""}" data-acct="">all</button>
      ${accounts.map((a) => `<button class="chip ${mailAccount === a ? "active" : ""}" data-acct="${esc(a)}">${accountTag(a)}</button>`).join("")}
    </div>` : "";
    const multi = accounts.length > 1 && !mailAccount;
    body.innerHTML = chips +
      (errors?.length ? errors.map((e) => `<div class="empty">⚠ ${esc(e)}</div>`).join("") : "") +
      (messages.length ? `<ul class="mail-list">` + messages.map((m) => `
      <li class="${m.unread ? "unread" : ""}" data-mail="${esc(m.id)}" data-mailacct="${esc(m.account)}" title="Open in Gmail">
        <div class="mail-top"><span class="mail-from">${multi ? `<span class="acct-tag">${accountTag(m.account)}</span>` : ""}${esc(m.from)}</span>
        <span class="when">${esc(m.date.replace(/:\d\d\s/, " ").split(" +")[0].slice(0, 22))}</span></div>
        <div class="mail-subject">${esc(m.subject)}</div>
      </li>`).join("") + `</ul>` : '<div class="empty">No mail. Suspiciously quiet, sir.</div>');
  } catch (e) {
    body.dataset.loaded = ""; // allow the next refresh cycle to retry
    body.innerHTML = `<div class="empty">mail error: ${esc(e.message)}</div>`;
  }
}

/* ---------- supabase status (settings) ---------- */
function renderSupaStatus(s) {
  $("supaStatus").innerHTML = s.online
    ? `<div class="kv"><span>status</span><b class="ok-txt">connected ✓</b></div>
       <div class="kv"><span>projects</span><b>${s.projects.length}</b></div>
       <div class="kv"><span>inbox items</span><b>${s.inbox.length}</b></div>
       <div class="kv"><span>memories</span><b>${s.memories.length}</b></div>
       <div class="kv"><span>daily logs</span><b>${s.logs.length}</b></div>`
    : `<div class="kv"><span>status</span><b class="bad-txt">offline ✗</b></div>
       <div class="empty">${esc(s.error || "check keys in Apps/hud/.env")}</div>`;
}

/* ---------- interactions ---------- */
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    if (e.target.id === "captureForm") {
      const v = $("captureInput").value.trim(); if (!v) return;
      await api("api/inbox", { content: v });
      $("captureInput").value = "";
      toast("Captured to inbox"); refresh();
    }
    if (e.target.id === "focusForm") {
      const v = $("focusInput").value.trim(); if (!v) return;
      await api("api/focus", { text: v });
      $("focusInput").value = "";
      toast("Focus item added"); refresh();
    }
    if (e.target.id === "projectForm") {
      const title = $("projTitle").value.trim(); if (!title) return;
      await api("api/projects", { title, outcome: $("projOutcome").value, firstAction: $("projAction").value });
      $("projectForm").reset(); $("projectForm").hidden = true;
      toast(`Project "${title}" created`); refresh();
    }
    if (e.target.id === "acctForm") {
      const name = $("acctName").value.trim(); if (!name) return;
      await api("api/finance/accounts", {
        op: "add",
        account: { type: $("acctType").value, name, institution: $("acctInst").value, last4: $("acctLast4").value.trim() },
      });
      e.target.reset();
      toast(`${name} registered`); loadFinance();
    }
    if (e.target.id === "goalForm") {
      const title = $("goalTitle").value.trim(); const target = Number($("goalTarget").value);
      if (!title || !(target > 0)) return;
      await api("api/finance/goals", { op: "add", goal: { title, target, deadline: $("goalDeadline").value } });
      e.target.reset();
      toast(`Goal "${title}" set — ${inr(target)}`); loadFinance();
    }
    if (e.target.id === "memoryForm") {
      const v = $("memoryInput").value.trim(); if (!v) return;
      await api("api/memories", { category: $("memoryCat").value, content: v });
      $("memoryInput").value = "";
      toast("Remembered"); refresh();
    }
  } catch (err) { toast(err.message, "err"); }
});

document.addEventListener("click", async (e) => {
  try {
    if (e.target.closest("#gearBtn")) return setView(document.body.classList.contains("settings") ? "hud" : "settings");

    if (e.target.closest("#brandBtn") || e.target.closest("#reactorWrap")) return toggleVoice();

    /* -- finance section -- */
    if (e.target.id === "finOpen") return setView("finance");
    if (e.target.id === "finBack") return setView("hud");
    if (e.target.id === "finScanFull") return loadFinance(true);
    const delAcct = e.target.closest("[data-del-acct]");
    if (delAcct) {
      if (confirm("Remove this account from the finance profile?")) {
        await api("api/finance/accounts", { op: "delete", id: delAcct.dataset.delAcct });
        toast("Account removed"); loadFinance();
      }
      return;
    }
    const delGoal = e.target.closest("[data-del-goal]");
    if (delGoal) {
      if (confirm("Remove this goal?")) {
        await api("api/finance/goals", { op: "delete", id: delGoal.dataset.delGoal });
        toast("Goal removed"); loadFinance();
      }
      return;
    }
    const goalSaved = e.target.closest(".goal-saved");
    if (goalSaved && !goalSaved.querySelector("input")) {
      const id = goalSaved.dataset.goal;
      const g = FIN?.profile.goals.find((x) => x.id === id);
      goalSaved.innerHTML = `<input class="area-edit goal-edit" type="number" value="${g?.saved ?? 0}" min="0">`;
      const input = goalSaved.querySelector("input");
      input.focus(); input.select();
      const commit = async () => {
        try { await api("api/finance/goals", { op: "update", id, saved: Number(input.value) }); toast("Goal progress updated"); }
        catch (err) { toast(err.message, "err"); }
        loadFinance();
      };
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") commit(); if (ev.key === "Escape") renderFinanceView(); });
      input.addEventListener("blur", commit, { once: true });
      return;
    }
    const catChip = e.target.closest(".cat-chip");
    if (catChip) return openCategoryPicker(catChip);
    const catF = e.target.closest("[data-cat-filter]");
    if (catF) { finFilter = catF.dataset.catFilter; return renderFinanceView(); }

    const doneBtn = e.target.closest(".done-btn");
    if (doneBtn) { await api("api/inbox/process", { id: doneBtn.dataset.id }); toast("Processed"); return refresh(); }

    const focusItem = e.target.closest(".focus-list .clickable");
    if (focusItem) {
      await api("api/focus/toggle", { text: focusItem.dataset.text, done: focusItem.dataset.done !== "true" });
      return refresh();
    }

    const actionItem = e.target.closest(".action-item");
    if (actionItem) { await api("api/actions/done", { id: actionItem.dataset.action }); toast("Action completed ✓"); return refresh(); }

    if (e.target.id === "newProjectBtn") { const f = $("projectForm"); f.hidden = !f.hidden; if (!f.hidden) $("projTitle").focus(); return; }

    const mailItem = e.target.closest("[data-mail]");
    if (mailItem) {
      window.open(`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(mailItem.dataset.mailacct)}#all/${mailItem.dataset.mail}`, "_blank");
      return;
    }

    const stat = e.target.closest(".stat[data-goto]");
    if (stat) {
      const panel = $(stat.dataset.goto);
      if (panel) { panel.classList.remove("flash"); void panel.offsetWidth; panel.classList.add("flash"); }
      return;
    }

    const areaHealth = e.target.closest(".area-health");
    if (areaHealth && !areaHealth.querySelector("input")) {
      const name = areaHealth.dataset.area;
      const current = areaHealth.classList.contains("unreviewed") ? "" : areaHealth.textContent;
      areaHealth.innerHTML = `<input class="area-edit" value="${esc(current)}" maxlength="120">`;
      const input = areaHealth.querySelector("input");
      input.focus();
      const commit = async () => {
        const v = input.value.trim();
        if (v && v !== current) { await api("api/areas", { name, health: v }); toast(`${name} updated`); }
        refresh();
      };
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") commit(); if (ev.key === "Escape") refresh(); });
      input.addEventListener("blur", commit, { once: true });
      return;
    }

    if (e.target.id === "gmailConnect" || e.target.id === "gmailAdd") {
      const { url } = await api("api/gmail/connect");
      window.location.href = url;
    }
    if (e.target.id === "finScan") return loadFinance(true);
    if (e.target.id === "mailRefresh") loadMail();
    const acctBtn = e.target.closest(".chip[data-acct]");
    if (acctBtn) { mailAccount = acctBtn.dataset.acct; return loadMail(); }
    const discBtn = e.target.closest(".chip-x");
    if (discBtn && confirm(`Disconnect ${discBtn.dataset.disconnect}?`)) {
      await api("api/gmail/disconnect", { email: discBtn.dataset.disconnect });
      if (mailAccount === discBtn.dataset.disconnect) mailAccount = "";
      toast("Account disconnected");
      $("gmailBody").dataset.loaded = "";
      return refresh();
    }

    const tog = e.target.closest("[data-toggle]");
    if (tog) return saveSettings({ panels: { [tog.dataset.toggle]: !SETTINGS.panels[tog.dataset.toggle] } });
    const interval = e.target.closest("[data-interval]");
    if (interval) return saveSettings({ refreshSeconds: Number(interval.dataset.interval) });
    const accent = e.target.closest("[data-accent]");
    if (accent) return saveSettings({ accent: accent.dataset.accent });
  } catch (err) { toast(err.message, "err"); }
});

/* ---------- main refresh ---------- */
let lastStateHash = "";
async function refresh() {
  if (document.hidden) return; // don't poll while the tab is in the background
  if (location.protocol === "file:") {
    $("backendStatus").textContent = "NOT SERVED";
    $("backendStatus").className = "pill pill-bad";
    $("statusDot").classList.add("offline");
    $("syncNote").textContent = "this page needs its server — run: node Apps/hud/server.mjs → http://localhost:3960";
    return;
  }
  try {
    const s = await api("api/state");
    const ok = !!s.online;
    if (s.settings) { SETTINGS = s.settings; applySettings.applied || (applySettings(), applySettings.applied = true); }
    $("backendStatus").textContent = ok ? "BACKEND ONLINE" : "BACKEND OFFLINE";
    $("backendStatus").className = `pill ${ok ? "pill-ok" : "pill-bad"}`;
    $("statusDot").classList.toggle("offline", !ok);
    renderSupaStatus(s);
    if (!ok) { $("syncNote").textContent = `backend unreachable — ${s.error || "check keys"}`; renderGmail(s.gmail); return; }
    // only rebuild the DOM when the data actually changed
    const { generatedAt, ...rest } = s;
    const hash = JSON.stringify(rest);
    if (hash !== lastStateHash) {
      lastStateHash = hash;
      renderFocus(s.logs);
      renderProjects(s.projects, s.actions);
      renderLog(s.logs);
      renderInbox(s.inbox);
      renderAreas(s.areas);
      renderMemory(s.memories);
      renderGmail(s.gmail);
      $("statProjects").textContent = s.projects.length;
      $("statInbox").textContent = s.inbox.length;
      $("statActions").textContent = s.actions.length;
      tiltNodes = [...document.querySelectorAll(".tilt")];
    }
    $("statMail").textContent = mailUnread;
    $("syncNote").textContent = `state synced ${new Date(s.generatedAt).toLocaleTimeString("en-IN", { hour12: false })} · every ${SETTINGS.refreshSeconds}s`;
  } catch (e) {
    $("backendStatus").textContent = "HUD ERROR";
    $("backendStatus").className = "pill pill-bad";
    $("syncNote").textContent = String(e.message || e);
  }
}
refresh();
loadFinance();
refreshTimer = setInterval(refresh, SETTINGS.refreshSeconds * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
