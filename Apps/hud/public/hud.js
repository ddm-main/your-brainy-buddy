// JARVIS HUD frontend — one-screen 3D control panel.
// Views: HUD (focus/projects/inbox/mail) + Settings (connections/display/system data).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const daysAgo = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

let SETTINGS = { accent: "#35d6ed", refreshSeconds: 30, language: "auto", panels: { focus: true, projects: true, finance: true, inbox: true, mail: true } };
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
// BCP-47 tag → label. "auto" lets the browser's default mic language handle
// input; JARVIS always replies in whichever of these three the question was
// asked in, regardless of this setting.
const LANGUAGES = [
  ["auto", "Auto"],
  ["en-IN", "English"],
  ["hi-IN", "हिंदी"],
  ["mr-IN", "मराठी"],
];

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
  $("languageChips").innerHTML = LANGUAGES.map(([tag, label]) => `
    <button class="chip ${(SETTINGS.language || "auto") === tag ? "active" : ""}" data-language="${tag}">${label}</button>`).join("");
}

/* ---------- view toggle: hud | settings | finance ---------- */
function setView(name) {
  const views = { hud: $("hudView"), settings: $("settingsView"), finance: $("financeView") };
  const current = Object.keys(views).find((k) => !views[k].hidden);
  if (current === name) return;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const finish = () => {
    document.body.classList.toggle("settings", name === "settings");
    for (const k of Object.keys(views)) views[k].hidden = k !== name;
    if (!reduced) {
      const next = views[name];
      next.classList.remove("view-entering");
      void next.offsetWidth; // restart the animation even if the class was already present
      next.classList.add("view-entering");
    }
    if (name === "finance") renderFinanceView();
  };
  const currentEl = current && views[current];
  if (currentEl && !reduced) {
    currentEl.classList.add("view-leaving");
    setTimeout(() => { currentEl.classList.remove("view-leaving"); finish(); }, 160);
  } else {
    finish();
  }
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
let conversationMode = false; // long-press starts a multi-turn conversation; plain click stays single-shot
let longPressFired = false;

function setVoiceState(state, statusText) {
  voiceState = state;
  document.body.dataset.voice = state;
  $("voiceStatus").textContent = statusText ?? { idle: "", listening: "◉ listening…", thinking: "◌ processing…", speaking: "▸ speaking" }[state];
  window.dispatchEvent(new CustomEvent("voice:state", { detail: state }));
}

let cachedVoice, cachedVoiceLang;
function jarvisVoice() {
  const tag = SETTINGS.language && SETTINGS.language !== "auto" ? SETTINGS.language : "en-IN";
  if (cachedVoice && cachedVoiceLang === tag) return cachedVoice;
  cachedVoiceLang = tag;
  const voices = speechSynthesis.getVoices();
  const short = tag.split("-")[0];
  if (short === "en") {
    const prefer = ["Google UK English Male", "Daniel", "Ryan", "George", "Microsoft Ryan Online (Natural) - English (United Kingdom)"];
    cachedVoice = prefer.map((n) => voices.find((v) => v.name.includes(n))).find(Boolean)
      || voices.find((v) => v.lang === "en-GB") || voices.find((v) => v.lang.startsWith("en")) || null;
  } else {
    cachedVoice = voices.find((v) => v.lang === tag) || voices.find((v) => v.lang.startsWith(short)) || null;
  }
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
  u.onend = u.onerror = () => {
    setVoiceState("idle");
    if (conversationMode) startListening(); // re-arm for the next turn
  };
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

function startListening() {
  if (!SR) { toast("Voice input needs Chrome or Edge (Web Speech API)", "err"); conversationMode = false; return; }
  recognizer = new SR();
  recognizer.lang = SETTINGS.language && SETTINGS.language !== "auto" ? SETTINGS.language : "en-IN";
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
    conversationMode = false;
    if (ev.error === "not-allowed") toast("Microphone blocked — allow mic access for localhost", "err");
    else if (ev.error !== "aborted" && ev.error !== "no-speech") toast(`voice error: ${ev.error}`, "err");
    if (ev.error === "no-speech") $("voiceYou").textContent = "» (heard nothing, sir)";
  };
  recognizer.onend = () => {
    if (voiceState !== "listening") return;
    if (transcript) askJarvis(transcript);
    else { setVoiceState("idle"); conversationMode = false; }
  };
  try { recognizer.start(); } catch { setVoiceState("idle"); conversationMode = false; }
}

// Plain click: single-shot ask (today's default behavior, unchanged). A
// long-press on the brand/globe instead starts a standing conversation —
// after each spoken reply, listening re-arms automatically until the user
// clicks again to stop (see startConversation / the pointer handlers below).
function toggleVoice() {
  if (voiceState === "listening") { conversationMode = false; recognizer?.stop(); return; }
  if (voiceState === "speaking") { conversationMode = false; speechSynthesis.cancel(); setVoiceState("idle"); return; }
  if (voiceState === "thinking") return;
  startListening();
}

function startConversation() {
  if (voiceState !== "idle") return;
  conversationMode = true;
  toast("Conversation mode — click JARVIS again to stop", "ok");
  startListening();
}

// Long-press (550ms) the brand/globe to start conversation mode; a normal
// click still falls through to the single-shot toggleVoice() in the main
// click handler below (guarded by longPressFired so it doesn't double-fire).
{
  let pressTimer = null;
  const cancelPress = () => clearTimeout(pressTimer);
  [$("brandBtn"), $("reactorWrap")].filter(Boolean).forEach((el) => {
    el.addEventListener("pointerdown", () => {
      longPressFired = false;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => { longPressFired = true; startConversation(); }, 550);
    });
    el.addEventListener("pointerup", cancelPress);
    el.addEventListener("pointerleave", cancelPress);
    el.addEventListener("pointercancel", cancelPress);
  });
}

/* ---------- renderers ---------- */
// Minimal keyed-list diff: reconciles `container`'s children against `items`
// (matched by keyFn) so unchanged rows stay untouched and only real
// additions/removals animate in/out — instead of a full innerHTML replace
// on every refresh. renderFn(item, el) sets el's className/attrs/innerHTML;
// diff-item bookkeeping classes are applied on top, not overwritten.
function diffList(container, items, keyFn, renderFn, tag = "div") {
  const existing = new Map([...container.children].map((el) => [el.dataset.key, el]));
  const frag = document.createDocumentFragment();
  for (const item of items) {
    const key = String(keyFn(item));
    let el = existing.get(key);
    const isNew = !el;
    if (el) existing.delete(key);
    else { el = document.createElement(tag); el.dataset.key = key; }
    renderFn(item, el);
    el.classList.add("diff-item");
    el.classList.remove("leaving");
    if (isNew) el.classList.add("entering");
    frag.appendChild(el);
  }
  for (const stale of existing.values()) {
    stale.classList.add("leaving");
    stale.addEventListener("transitionend", () => stale.remove(), { once: true });
    setTimeout(() => stale.remove(), 400);
  }
  container.innerHTML = "";
  container.append(frag, ...existing.values());
  requestAnimationFrame(() => container.querySelectorAll(".entering").forEach((el) => el.classList.remove("entering")));
}

function renderFocus(logs) {
  const today = new Date().toLocaleDateString("en-CA");
  const todayLog = logs.find((l) => l.log_date === today);
  const el = $("focusList");
  const section = todayLog ? (todayLog.content.split(/^##\s*Today'?s Focus\s*$/mi)[1] || "") : "";
  const items = [...section.matchAll(/^-\s*\[([ xX])\]\s*(.+)$/gm)].map(([, done, text]) => ({ done: done.trim().toLowerCase() === "x", text: text.trim() }));
  if (!items.length) { el.innerHTML = '<li class="empty">No focus set — run /brief or add one below</li>'; return; }
  diffList(el, items, (i) => i.text, (i, li) => {
    li.className = i.done ? "done clickable" : "clickable";
    li.dataset.text = i.text;
    li.dataset.done = i.done;
    li.title = "Click to toggle";
    li.innerHTML = `<span class="box">${i.done ? "◉" : "◯"}</span><span>${esc(i.text)}</span>`;
  }, "li");
}

function renderProjects(projects, actions) {
  $("projectCount").textContent = projects.length ? `· ${projects.length}` : "";
  const el = $("projectList");
  if (!projects.length) { el.innerHTML = '<div class="empty">No active projects — hit “+ new”</div>'; return; }
  diffList(el, projects, (p) => p.id, (p, div) => {
    const acts = actions.filter((a) => a.project_id === p.id);
    const stale = daysAgo(p.updated_at) > 14;
    const total = p.totalActions || 0;
    const pct = total ? Math.round(((p.doneActions || 0) / total) * 100) : 0;
    div.className = "project";
    div.innerHTML = `
      <div class="project-name clickable" data-project-open="${esc(p.slug || p.id)}" title="Click for full detail">${esc(p.title)}<span class="badge">${esc(p.status)}</span></div>
      ${total ? `<div class="goal-bar"><div class="goal-fill" style="width:${pct}%"></div></div>` : ""}
      ${acts.length
        ? acts.slice(0, 3).map((a) => `<div class="project-meta action-item" data-action="${esc(a.id)}" title="Click to complete">◯ ${esc(a.description)}</div>`).join("")
        : '<div class="project-meta stale">⚠ no next action</div>'}
      ${stale ? '<div class="project-meta stale">⚠ stale — untouched 14+ days</div>' : ""}
      <form class="project-quickadd" data-project-slug="${esc(p.slug || p.id)}">
        <input type="text" placeholder="+ add next action…" maxlength="140" autocomplete="off">
      </form>
    `;
  });
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
  if (!inbox.length) { el.innerHTML = '<li class="empty">Nothing captured. Immaculate, sir.</li>'; return; }
  diffList(el, inbox, (i) => i.id, (i, li) => {
    li.innerHTML = `<span>${esc(i.content)}</span><span class="when">${esc(i.captured_on)}</span>
     <button class="mini-btn done-btn" data-id="${esc(i.id)}" title="Mark processed">✓</button>`;
  }, "li");
}

// Proactive monitoring banner — computed client-side from data /api/state
// already fetches every refresh, no extra backend calls. Dismissing hides it
// for the rest of the day (localStorage, keyed by date so it reappears
// tomorrow if the underlying issue is still there).
function renderBriefBanner(projects, inbox) {
  const today = new Date().toLocaleDateString("en-CA");
  const banner = $("briefBanner");
  if (localStorage.getItem("briefDismissed") === today) { banner.hidden = true; return; }
  const stale = projects.filter((p) => daysAgo(p.updated_at) > 14).length;
  const overdue = projects.filter((p) => p.deadline && p.deadline < today).length;
  const backlog = inbox.length > 5 ? inbox.length : 0;
  const parts = [];
  if (overdue) parts.push(`${overdue} project${overdue > 1 ? "s" : ""} past deadline`);
  if (stale) parts.push(`${stale} project${stale > 1 ? "s" : ""} untouched 14+ days`);
  if (backlog) parts.push(`${backlog} items sitting in inbox`);
  if (!parts.length) { banner.hidden = true; return; }
  $("briefText").textContent = `⚠ ${parts.join(" · ")}`;
  banner.hidden = false;
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
let openAcctLockId = null; // which account's statement-password panel is expanded
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

// Receipt OCR: read the chosen photo as base64 and hand it to the vision LLM
// server-side (no client-side OCR dependency) to log it as a transaction.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("could not read file"));
    reader.readAsDataURL(file);
  });
}
$("finReceiptInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // allow re-selecting the same file next time
  if (!file) return;
  toast("Reading receipt…");
  try {
    const image = await fileToBase64(file);
    FIN = await api("api/finance/receipt", { image, mimeType: file.type || "image/jpeg" });
    toast(`Logged ₹${FIN.transactions[FIN.transactions.length - 1]?.amount ?? "?"} from receipt`);
    renderFinancePanel();
    if (!$("financeView").hidden) renderFinanceView();
  } catch (err) {
    toast(err.message, "err");
  }
});

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

// Dashboard heads-up alerts (unusual spend / missing statement / upcoming
// payment) computed server-side fresh on every fetch — no dismiss state to
// track, they just stop showing once the underlying condition clears.
function renderFinAlerts(alerts) {
  const el = $("finAlerts");
  if (!alerts?.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = alerts.map((a) => `<span class="fin-alert fin-alert-${esc(a.severity)}">${a.severity === "warn" ? "⚠" : "ℹ"} ${esc(a.message)}</span>`).join("");
}

// Ambiguous statement-line-item matches (2+ same-amount/date-window
// candidates) — pick a candidate or confirm it's a new transaction.
function renderReviewQueue(queue) {
  $("reviewCount").textContent = queue?.length ? `· ${queue.length}` : "";
  $("reviewList").innerHTML = queue?.length
    ? queue.map((r) => `
      <div class="review-item">
        <div class="review-top">
          <span>${esc(r.lineItem.merchant || "unknown merchant")}</span>
          <span class="amt ${esc(r.lineItem.type)}">${r.lineItem.type === "debit" ? "−" : "+"}₹${r.lineItem.amount.toLocaleString("en-IN")}</span>
        </div>
        <div class="review-meta">statement line item · ${esc(r.date)}</div>
        <div class="chip-row">
          ${r.candidates.map((c) => `<button class="chip" data-review-resolve="${esc(r.id)}" data-choice="${esc(c.txId)}" title="${esc(c.reason)}">match (${Math.round(c.score * 100)}%)</button>`).join("")}
          <button class="chip chip-add" data-review-resolve="${esc(r.id)}" data-choice="new">none — add as new</button>
        </div>
      </div>`).join("")
    : '<div class="empty">Nothing to review</div>';
}

// Hand-rolled SVG bar chart, no charting dependency — last 6 months of
// spent vs. received from the same monthly totals the dashboard already has.
function renderSpendChart(totals) {
  const el = $("spendChart");
  const months = Object.keys(totals || {}).sort().slice(-6);
  if (!months.length) { el.innerHTML = '<div class="empty">Not enough history yet</div>'; return; }
  const W = 280, H = 120, pad = 20;
  const max = Math.max(1, ...months.flatMap((m) => [totals[m].spent, totals[m].received]));
  const bw = (W - pad * 2) / months.length;
  const bars = months.map((m, i) => {
    const x = pad + i * bw;
    const spentH = (totals[m].spent / max) * (H - pad * 2);
    const recvH = (totals[m].received / max) * (H - pad * 2);
    return `
      <rect x="${x + 2}" y="${H - pad - spentH}" width="${bw / 2 - 3}" height="${spentH}" fill="var(--alert)" opacity="0.8" rx="2"></rect>
      <rect x="${x + bw / 2 + 1}" y="${H - pad - recvH}" width="${bw / 2 - 3}" height="${recvH}" fill="var(--good)" opacity="0.8" rx="2"></rect>
      <text x="${x + bw / 2}" y="${H - pad + 12}" text-anchor="middle" class="chart-label">${esc(m.slice(5))}</text>`;
  }).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H + 10}" class="fin-chart">${bars}<line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" class="chart-axis"></line></svg>
    <div class="chart-legend"><span><i style="background:var(--alert)"></i>spent</span><span><i style="background:var(--good)"></i>received</span></div>`;
}

// Hand-rolled SVG donut — current month's category split, alongside (not
// replacing) the existing catBars list so both a quick-scan list and a
// proportional visual are available.
function renderCatDonut(cats) {
  const el = $("catDonut");
  const total = cats.reduce((s, [, v]) => s + v, 0);
  if (!total) { el.innerHTML = ""; return; }
  const colors = ["var(--accent)", "var(--good)", "var(--warn)", "var(--alert)", "var(--accent-dim)", "var(--ink-3)"];
  const r = 40, cx = 50, cy = 50, circumference = 2 * Math.PI * r;
  let offset = 0;
  const segs = cats.slice(0, 6).map(([, v], i) => {
    const dash = (v / total) * circumference;
    const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="16"
      stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"></circle>`;
    offset += dash;
    return seg;
  }).join("");
  el.innerHTML = `<svg viewBox="0 0 100 100" class="fin-donut">${segs}</svg>`;
}

function renderFinanceView() {
  if (!FIN) return;
  const p = FIN.profile;
  const month = new Date().toLocaleDateString("en-CA").slice(0, 7);
  renderFinAlerts(FIN.alerts);
  renderReviewQueue(FIN.reviewQueue);
  renderSpendChart(FIN.totals);

  /* accounts / cards */
  $("acctCount").textContent = p.accounts.length ? `· ${p.accounts.length}` : "";
  const gmailAccts = FIN.gmail?.accounts || [];
  $("acctList").innerHTML = p.accounts.length
    ? p.accounts.map((a) => `
      <div class="acct-row">
        <span class="acct-icon">${ACCT_ICON[a.type] || "•"}</span>
        <span class="acct-main"><b>${esc(a.name)}</b>
          <span class="acct-sub">${esc(a.institution || ACCT_LABEL[a.type] || "")}${a.last4 ? ` ··${esc(a.last4)}` : ""}${a.hasPassword ? " · 🔒 statement password set" : ""}</span></span>
        <button class="chip-x" data-acct-lock="${esc(a.id)}" title="Statement email / password settings">⚙</button>
        <button class="chip-x" data-del-acct="${esc(a.id)}" title="Remove ${esc(a.name)}">×</button>
      </div>
      <div class="acct-lock-panel" id="acctLock-${esc(a.id)}" ${openAcctLockId === a.id ? "" : "hidden"}>
        <div class="set-title">Which connected Gmail address(es) get this account's statements?</div>
        <div class="chip-row">${gmailAccts.map((e) => `
          <button class="chip ${a.gmailAddresses?.includes(e) ? "active" : ""}" data-acct-gmail="${esc(a.id)}" data-email="${esc(e)}">${esc(e.split("@")[0])}</button>`).join("") || '<span class="empty">connect Gmail first</span>'}</div>
        <div class="set-title">Statement PDF passwords — tried in order (banks that change format, or a couple of guesses)</div>
        ${(a.passwordCount || 0) > 0
          ? `<div class="chip-row">${Array.from({ length: a.passwordCount }, (_, i) => `
              <span class="chip-group"><span class="chip active">password ${i + 1}</span>
                <button class="chip-x" data-pw-remove="${esc(a.id)}" data-pw-index="${i}" title="Remove this password">×</button></span>`).join("")}</div>`
          : ""}
        <div class="row">
          <input type="password" class="acct-pw-input" data-acct-pw="${esc(a.id)}" placeholder="add a statement PDF password" maxlength="60" autocomplete="new-password">
          <input type="text" class="acct-hint-input" data-acct-hint="${esc(a.id)}" placeholder="hint (e.g. DDMMYYYY of DOB)" maxlength="80" value="${esc(a.passwordHint || "")}">
          <button data-acct-pw-save="${esc(a.id)}">add</button>
        </div>
        ${a.type === "credit_card" ? `
        <div class="set-title">Payment due date (this cycle)</div>
        <div class="row">
          <input type="date" class="acct-due-input" data-acct-due="${esc(a.id)}" value="${esc(a.dueDate || "")}">
          <button data-acct-due-save="${esc(a.id)}">save</button>
        </div>` : ""}
      </div>`).join("")
    : '<div class="empty">Nothing registered yet — add your banks and cards below. The last-4 digits let me pin transactions to the right account.</div>';

  /* goals */
  $("goalCount").textContent = p.goals.length ? `· ${p.goals.length}` : "";
  $("goalList").innerHTML = p.goals.length
    ? p.goals.map((g) => {
      const pct = Math.min(100, Math.round((g.saved / g.target) * 100));
      return `<li class="goal">
        <div class="goal-top"><span>${esc(g.title)}${g.autoTrack ? ' <span class="acct-sub">(auto)</span>' : ""}</span>
          <span class="goal-nums"><b class="goal-saved" ${g.autoTrack ? "" : `data-goal="${esc(g.id)}" title="Click to update saved amount"`}>${inr(g.saved)}</b> / ${inr(g.target)}</span>
          <button class="chip-x" data-del-goal="${esc(g.id)}" title="Remove goal">×</button></div>
        <div class="goal-bar"><div class="goal-fill" style="width:${pct}%"></div></div>
        <div class="goal-meta">${pct}%${g.deadline ? ` · by ${esc(g.deadline)}` : ""}</div>
      </li>`;
    }).join("")
    : '<li class="empty">No goals yet — give me a target, sir</li>';

  /* loans — payoffPct/monthsRemaining/totalInterestRemaining/projectedPayoffDate
     are computed server-side (computeAmortization) so voice answers and the
     UI always agree. */
  const loans = p.loans || [];
  $("loanCount").textContent = loans.length ? `· ${loans.length}` : "";
  $("loanList").innerHTML = loans.length
    ? loans.map((l) => {
      const pct = l.payoffPct ?? 0;
      const payoff = l.monthsRemaining == null
        ? "EMI doesn't cover interest — will never pay off at this rate"
        : `${l.monthsRemaining} mo left${l.totalInterestRemaining != null ? ` · ${inr(l.totalInterestRemaining)} interest remaining` : ""}`;
      return `<li class="goal">
        <div class="goal-top"><span>${esc(l.name)}${l.lender ? ` <span class="acct-sub">${esc(l.lender)}</span>` : ""}</span>
          <span class="goal-nums"><b>${inr(l.outstandingBalance)}</b> / ${inr(l.principal)}</span>
          <button class="chip-x" data-del-loan="${esc(l.id)}" title="Remove loan">×</button></div>
        <div class="goal-bar"><div class="goal-fill" style="width:${pct}%"></div></div>
        <div class="goal-meta">${pct}% repaid · EMI ${inr(l.emiAmount)}${l.nextDueDate ? ` · next due ${esc(l.nextDueDate)}` : ""}</div>
        <div class="goal-meta">${payoff}${l.projectedPayoffDate ? ` · payoff ~${esc(l.projectedPayoffDate)}` : ""}</div>
      </li>`;
    }).join("")
    : '<div class="empty">No loans tracked yet</div>';

  /* category bars for current month */
  const byCat = {};
  for (const t of FIN.transactions) {
    if (t.date.startsWith(month) && t.type === "debit" && t.currency === "INR") byCat[t.category] = (byCat[t.category] || 0) + t.amount;
  }
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const max = cats[0]?.[1] || 1;
  renderCatDonut(cats);
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
let mailMessages = [];
let mailNextPageToken = null;
let mailReaderState = null; // { id, account, threadId, subject, from, messageIdHeader, references, unread }
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

async function loadMail(reset = true) {
  const body = $("gmailBody");
  body.dataset.loaded = "1";
  if (reset) { mailMessages = []; mailNextPageToken = null; body.innerHTML = '<div class="empty">fetching mail…</div>'; }
  try {
    const params = new URLSearchParams();
    if (mailAccount) params.set("account", mailAccount);
    if (!reset && mailNextPageToken) params.set("pageToken", mailNextPageToken);
    const { ok, messages, nextPageToken, errors, accounts, error } = await api(`api/gmail/messages${params.toString() ? `?${params}` : ""}`);
    if (!ok) throw new Error(error);
    mailMessages = reset ? messages : [...mailMessages, ...messages];
    mailNextPageToken = nextPageToken || null;
    mailUnread = mailMessages.filter((m) => m.unread).length;
    $("statMail").textContent = mailUnread;
    $("mailCount").textContent = mailMessages.length ? `· ${mailMessages.length}` : "";
    const chips = accounts.length > 1 ? `<div class="chip-row">
      <button class="chip ${mailAccount === "" ? "active" : ""}" data-acct="">all</button>
      ${accounts.map((a) => `<button class="chip ${mailAccount === a ? "active" : ""}" data-acct="${esc(a)}">${accountTag(a)}</button>`).join("")}
    </div>` : "";
    const multi = accounts.length > 1 && !mailAccount;
    body.innerHTML = chips +
      (errors?.length ? errors.map((e) => `<div class="empty">⚠ ${esc(e)}</div>`).join("") : "") +
      (mailMessages.length ? `<ul class="mail-list">` + mailMessages.map((m) => `
      <li class="${m.unread ? "unread" : ""}" data-mail="${esc(m.id)}" data-mailacct="${esc(m.account)}" title="Open message">
        <div class="mail-top"><span class="mail-from">${multi ? `<span class="acct-tag">${accountTag(m.account)}</span>` : ""}${esc(m.from)}</span>
        <span class="when">${esc(m.date.replace(/:\d\d\s/, " ").split(" +")[0].slice(0, 22))}</span></div>
        <div class="mail-subject">${esc(m.subject)}</div>
      </li>`).join("") + `</ul>` : '<div class="empty">No mail. Suspiciously quiet, sir.</div>') +
      (mailNextPageToken && mailAccount ? `<button class="mini-btn" id="mailLoadMore">Load more</button>` : "");
  } catch (e) {
    body.dataset.loaded = ""; // allow the next refresh cycle to retry
    body.innerHTML = `<div class="empty">mail error: ${esc(e.message)}</div>`;
  }
}

/* ---------- mail reader: full read / reply / delete / mark-read ---------- */
async function openMailReader(id, account) {
  const reader = $("mailReader");
  reader.hidden = false;
  $("mailReaderSubject").textContent = "loading…";
  $("mailReaderFrom").textContent = "";
  $("mailReaderBody").textContent = "";
  $("mailReplyForm").hidden = true;
  try {
    const { ok, message, error } = await api(`api/gmail/message?account=${encodeURIComponent(account)}&id=${encodeURIComponent(id)}`);
    if (!ok) throw new Error(error);
    mailReaderState = message;
    $("mailReaderSubject").textContent = message.subject;
    $("mailReaderFrom").textContent = `${message.from} · ${message.date}`;
    $("mailReaderBody").textContent = message.body;
    $("mailReaderExternal").href = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account)}#all/${id}`;
    $("mailReaderUnread").textContent = message.unread ? "● unread" : "○ read";
    if (message.unread) {
      await api("api/gmail/read", { account, id, unread: false });
      message.unread = false;
      const inList = mailMessages.find((m) => m.id === id);
      if (inList) inList.unread = false;
      document.querySelector(`#gmailBody [data-mail="${CSS.escape(id)}"]`)?.classList.remove("unread");
      mailUnread = mailMessages.filter((m) => m.unread).length;
      $("statMail").textContent = mailUnread;
    }
  } catch (e) {
    $("mailReaderSubject").textContent = "error";
    $("mailReaderBody").textContent = e.message;
  }
}
function closeMailReader() {
  $("mailReader").hidden = true;
  mailReaderState = null;
  $("mailReplyForm").hidden = true;
}

/* ---------- project drill-in detail ---------- */
async function openProjectDetail(slug) {
  const panel = $("projectDetail");
  panel.hidden = false;
  $("projectDetailTitle").textContent = "loading…";
  $("projectDetailMeta").textContent = "";
  $("projectDetailBody").textContent = "";
  try {
    const d = await api(`api/projects/detail?slug=${encodeURIComponent(slug)}`);
    $("projectDetailTitle").textContent = d.title;
    $("projectDetailMeta").textContent = `${d.status || "active"}${d.outcome ? ` · ${d.outcome}` : ""}${d.deadline ? ` · due ${d.deadline}` : ""}`;
    const actions = [...d.nextActions.matchAll(/^-\s*\[([ xX])\]\s*(.+)$/gm)]
      .map(([, done, text]) => `${done.trim() ? "☑" : "☐"} ${esc(text)}`).join("\n") || "(none)";
    const log = [...d.log.matchAll(/^-\s+(.+)$/gm)].map((m) => `· ${esc(m[1])}`).join("\n") || "(none)";
    $("projectDetailBody").innerHTML = `<b>Next actions</b>\n${actions}\n\n<b>Log</b>\n${log}`;
  } catch (e) {
    $("projectDetailTitle").textContent = "error";
    $("projectDetailBody").textContent = e.message;
  }
}
function closeProjectDetail() { $("projectDetail").hidden = true; }

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
    if (e.target.classList.contains("project-quickadd")) {
      const input = e.target.querySelector("input");
      const description = input.value.trim(); if (!description) return;
      await api("api/actions", { projectSlug: e.target.dataset.projectSlug, description });
      input.value = "";
      toast("Next action added"); refresh();
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
    if (e.target.id === "loanForm") {
      const name = $("loanName").value.trim(); const principal = Number($("loanPrincipal").value);
      if (!name || !(principal > 0)) return;
      await api("api/finance/loans", {
        op: "add",
        loan: { name, lender: $("loanLender").value.trim(), principal, emiAmount: Number($("loanEmi").value) || 0 },
      });
      e.target.reset();
      toast(`Loan "${name}" added`); loadFinance();
    }
    if (e.target.id === "scanRangeForm") {
      const from = $("scanRangeFrom").value; const to = $("scanRangeTo").value;
      if (!from || !to) return;
      toast("Scanning date range…");
      const result = await api("api/finance/scan/range", { from, to });
      FIN = result;
      renderFinancePanel(); renderFinanceView();
      toast(result.added ? `${result.added} new transaction${result.added > 1 ? "s" : ""} found` : "No new transactions in range");
    }
    if (e.target.id === "memoryForm") {
      const v = $("memoryInput").value.trim(); if (!v) return;
      await api("api/memories", { category: $("memoryCat").value, content: v });
      $("memoryInput").value = "";
      toast("Remembered"); refresh();
    }
    if (e.target.id === "mailReplyForm") {
      const bodyText = $("mailReplyText").value.trim();
      if (!bodyText || !mailReaderState) return;
      const m = mailReaderState;
      await api("api/gmail/reply", {
        account: m.account, threadId: m.threadId, to: m.from, subject: m.subject,
        inReplyTo: m.messageIdHeader, references: m.references, bodyText,
      });
      $("mailReplyText").value = "";
      $("mailReplyForm").hidden = true;
      toast("Reply sent");
    }
  } catch (err) { toast(err.message, "err"); }
});

document.addEventListener("click", async (e) => {
  try {
    if (e.target.closest("#gearBtn")) return setView(document.body.classList.contains("settings") ? "hud" : "settings");

    if (e.target.closest("#briefSpeakBtn")) {
      if ($("hudView").hidden) setView("hud");
      return askJarvis("Give me my morning briefing, sir — today's focus, project status, and anything overdue or stale.");
    }
    if (e.target.closest("#briefDismissBtn")) {
      localStorage.setItem("briefDismissed", new Date().toLocaleDateString("en-CA"));
      $("briefBanner").hidden = true;
      return;
    }

    if (e.target.closest("#brandBtn") || e.target.closest("#reactorWrap")) {
      if (longPressFired) { longPressFired = false; return; } // already handled by the long-press timer
      if ($("hudView").hidden) setView("hud"); // clicking JARVIS always brings you home first
      return toggleVoice();
    }

    /* -- finance section -- */
    if (e.target.id === "finOpen") return setView("finance");
    if (e.target.id === "finBack") return setView("hud");
    if (e.target.id === "finScanFull") return loadFinance(true);
    if (e.target.id === "finAutoCat") {
      toast("Asking JARVIS to categorize…");
      try {
        const result = await api("api/finance/categorize/auto");
        FIN = result;
        renderFinancePanel(); renderFinanceView();
        toast(result.categorized ? `${result.categorized} transaction${result.categorized > 1 ? "s" : ""} categorized` : "Nothing to categorize");
      } catch (e2) { toast(e2.message, "err"); }
      return;
    }
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

    const reviewResolve = e.target.closest("[data-review-resolve]");
    if (reviewResolve) {
      try {
        await api("api/finance/reconcile/resolve", { reviewId: reviewResolve.dataset.reviewResolve, choice: reviewResolve.dataset.choice });
        toast("Reconciled");
        loadFinance();
      } catch (err) { toast(err.message, "err"); }
      return;
    }
    const delLoan = e.target.closest("[data-del-loan]");
    if (delLoan) {
      if (confirm("Remove this loan?")) {
        await api("api/finance/loans", { op: "delete", id: delLoan.dataset.delLoan });
        toast("Loan removed"); loadFinance();
      }
      return;
    }
    const acctLock = e.target.closest("[data-acct-lock]");
    if (acctLock) {
      const id = acctLock.dataset.acctLock;
      openAcctLockId = openAcctLockId === id ? null : id;
      return renderFinanceView();
    }
    const acctGmail = e.target.closest("[data-acct-gmail]");
    if (acctGmail) {
      const id = acctGmail.dataset.acctGmail;
      const a = FIN?.profile.accounts.find((x) => x.id === id);
      const current = new Set(a?.gmailAddresses || []);
      const email = acctGmail.dataset.email;
      current.has(email) ? current.delete(email) : current.add(email);
      await api("api/finance/accounts", { op: "setGmailAddresses", id, account: { gmailAddresses: [...current] } });
      toast("Statement email binding updated"); loadFinance();
      return;
    }
    const acctPwSave = e.target.closest("[data-acct-pw-save]");
    if (acctPwSave) {
      const id = acctPwSave.dataset.acctPwSave;
      const password = document.querySelector(`[data-acct-pw="${id}"]`)?.value.trim();
      const passwordHint = document.querySelector(`[data-acct-hint="${id}"]`)?.value.trim();
      if (!password) { toast("Enter a password first", "err"); return; }
      await api("api/finance/accounts", { op: "addPassword", id, account: { password, passwordHint } });
      toast("Statement password added (encrypted)"); loadFinance();
      return;
    }
    const pwRemove = e.target.closest("[data-pw-remove]");
    if (pwRemove) {
      await api("api/finance/accounts", { op: "removePassword", id: pwRemove.dataset.pwRemove, account: { index: Number(pwRemove.dataset.pwIndex) } });
      toast("Password removed"); loadFinance();
      return;
    }
    const acctDueSave = e.target.closest("[data-acct-due-save]");
    if (acctDueSave) {
      const id = acctDueSave.dataset.acctDueSave;
      const dueDate = document.querySelector(`[data-acct-due="${id}"]`)?.value || "";
      await api("api/finance/accounts", { op: "setDueDate", id, account: { dueDate } });
      toast("Due date saved"); loadFinance();
      return;
    }

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
      // Recent Mail panel rows open the in-app reader; Finance rows (which
      // share the same [data-mail] markup to reference a grounding email)
      // keep opening Gmail's own web UI in a new tab.
      if (mailItem.closest("#gmailBody")) return openMailReader(mailItem.dataset.mail, mailItem.dataset.mailacct);
      window.open(`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(mailItem.dataset.mailacct)}#all/${mailItem.dataset.mail}`, "_blank");
      return;
    }
    if (e.target.closest("#mailLoadMore")) return loadMail(false);
    if (e.target.closest("#mailReaderClose") || e.target.closest("#mailReaderBackdrop")) return closeMailReader();
    const projOpen = e.target.closest("[data-project-open]");
    if (projOpen) return openProjectDetail(projOpen.dataset.projectOpen);
    if (e.target.closest("#projectDetailClose") || e.target.closest("#projectDetailBackdrop")) return closeProjectDetail();
    if (e.target.closest("#mailReaderReplyToggle")) {
      const f = $("mailReplyForm");
      f.hidden = !f.hidden;
      if (!f.hidden) $("mailReplyText").focus();
      return;
    }
    if (e.target.closest("#mailReaderTrash")) {
      if (mailReaderState && confirm("Move this message to trash?")) {
        await api("api/gmail/trash", { account: mailReaderState.account, id: mailReaderState.id });
        mailMessages = mailMessages.filter((m) => m.id !== mailReaderState.id);
        toast("Moved to trash");
        closeMailReader();
        loadMail();
      }
      return;
    }
    if (e.target.closest("#mailReaderUnread")) {
      if (mailReaderState) {
        const nextUnread = !mailReaderState.unread;
        await api("api/gmail/read", { account: mailReaderState.account, id: mailReaderState.id, unread: nextUnread });
        mailReaderState.unread = nextUnread;
        $("mailReaderUnread").textContent = nextUnread ? "● unread" : "○ read";
        const inList = mailMessages.find((m) => m.id === mailReaderState.id);
        if (inList) inList.unread = nextUnread;
        loadMail();
      }
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
    const language = e.target.closest("[data-language]");
    if (language) return saveSettings({ language: language.dataset.language });
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
      renderBriefBanner(s.projects, s.inbox);
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
