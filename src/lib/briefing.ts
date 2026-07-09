import { jarvisChat } from "@/lib/jarvisChat";

const KEY_PREFIX = "jarvis:briefing:";

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function shouldRunBriefing(): boolean {
  try {
    return !localStorage.getItem(KEY_PREFIX + today());
  } catch {
    return false;
  }
}

export function markBriefingDone() {
  try { localStorage.setItem(KEY_PREFIX + today(), "1"); } catch { /* noop */ }
}

export async function runMorningBriefing() {
  if (!shouldRunBriefing()) return;
  markBriefingDone();
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const prompt =
    `System briefing request. Deliver a one-line ${greet.toLowerCase()} greeting to Deepak, ` +
    `then in the same turn call web_search{mode:"news"} for "today world tech news" and weather{location:"Mumbai"}. ` +
    `After the tool results, summarize the top news headline and current weather in two short sentences.`;
  try {
    await jarvisChat(prompt);
  } catch (err) {
    console.warn("briefing failed", err);
  }
}