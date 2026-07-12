// Client for the jarvis-chat edge function. Parses AI SDK v5 UI message stream
// (SSE) — text deltas AND tool-input / tool-output parts — and dispatches
// side-effects (content cards, vision capture) as they stream in.

import { useContent } from "@/store/contentStore";
import { useVoice } from "@/store/voiceStore";
import { captureAndDescribe } from "@/lib/vision";
import { useBrain } from "@/store/brainStore";
import { supabase as _supabase } from "@/integrations/supabase/client";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = _supabase as any;
import { runToolIntent } from "@/lib/jarvisTools";
import { authHeaders } from "@/lib/authFetch";
import { useAiStatus } from "@/store/aiStatusStore";
import { useUi } from "@/store/uiStore";

type Role = "user" | "assistant";
type MsgPart =
  | { type: "text"; text: string }
  | { type: string; [k: string]: unknown };
export interface HistoryMessage {
  id: string;
  role: Role;
  parts: MsgPart[];
}

export interface JarvisChatOpts {
  mode?: "text" | "voice" | "screen";
  screenshotUrl?: string;
}

const HISTORY_CAP = 12;
const history: HistoryMessage[] = [];
let inflight: AbortController | null = null;

function endpoint() {
  const base = import.meta.env.VITE_SUPABASE_URL as string;
  return `${base}/functions/v1/jarvis-chat`;
}

function mkId() {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function resetJarvisHistory() {
  history.length = 0;
}

export function abortJarvisStream() {
  try { inflight?.abort(); } catch { /* noop */ }
  inflight = null;
}

export function getJarvisHistory(): ReadonlyArray<HistoryMessage> {
  return history;
}

/** Send a user utterance, stream the reply, return the full assistant text.
 * Thin wrapper around jarvisChatInner that updates the TopBar "AI" status
 * chip from the real outcome — no extra network traffic, piggybacks on
 * whatever the app is already doing. */
export async function jarvisChat(
  userText: string,
  onDelta?: (chunk: string) => void,
  opts: JarvisChatOpts = {},
): Promise<string> {
  try {
    const result = await jarvisChatInner(userText, onDelta, opts);
    useAiStatus.getState().setOk(true);
    return result;
  } catch (err) {
    // A user-initiated abort ("interrupted") isn't an AI-availability
    // failure — only flip the chip red for real connection/upstream errors.
    if (err instanceof Error && err.message !== "interrupted") {
      useAiStatus.getState().setOk(false);
    }
    throw err;
  }
}

async function jarvisChatInner(
  userText: string,
  onDelta?: (chunk: string) => void,
  opts: JarvisChatOpts = {},
): Promise<string> {
  const startedAt = Date.now();
  const brain = useBrain.getState();
  const userMsg: HistoryMessage = { id: mkId(), role: "user", parts: [{ type: "text", text: userText }] };
  history.push(userMsg);
  while (history.length > HISTORY_CAP) history.shift();

  useVoice.getState().setVisionBusy(false);

  inflight?.abort();
  const ctrl = new AbortController();
  inflight = ctrl;

  const delays = [3000, 6000, 12000, 60000];
  let res: Response | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      res = await fetch(endpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await authHeaders()),
        },
        body: JSON.stringify({
          messages: history,
          provider: brain.provider,
          model: brain.model,
          screenshotUrl: opts.screenshotUrl,
          mode: opts.mode ?? "text",
        }),
        signal: ctrl.signal,
      });
      if (res.ok && res.body) break;
      // Retryable upstream
      if ([502, 503, 504].includes(res.status) && attempt < delays.length) {
        lastErr = new Error(`upstream ${res.status}`);
      } else {
        const detail = await res.text().catch(() => "");
        history.pop();
        if (res.status === 402) throw new Error("AI credits exhausted. Add credits to continue.");
        if (res.status === 429) throw new Error("Rate limited. Try again in a moment.");
        throw new Error(`JARVIS unavailable (${res.status}): ${detail.slice(0, 200)}`);
      }
    } catch (err: any) {
      if (err?.name === "AbortError") { history.pop(); throw new Error("interrupted"); }
      lastErr = err;
      // network error: retryable
      if (attempt >= delays.length) {
        history.pop();
        throw new Error("Connection lost. Please retry.");
      }
    }
    // Backoff + toast
    const base = delays[attempt];
    const jitter = base * (0.75 + Math.random() * 0.5);
    try {
      const { useVoice } = await import("@/store/voiceStore");
      const { useUi } = await import("@/store/uiStore");
      useVoice.getState().setState("paused");
      useUi.getState().push(`Reconnecting… (attempt ${attempt + 1})`, "warn");
    } catch { /* noop */ }
    await new Promise((r) => setTimeout(r, jitter));
    if (ctrl.signal.aborted) { history.pop(); throw new Error("interrupted"); }
  }

  if (!res || !res.ok || !res.body) {
    history.pop();
    throw new Error(lastErr instanceof Error ? lastErr.message : "Connection lost. Please retry.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  const toolInputs = new Map<string, { name: string; input?: unknown }>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const evt of events) {
        const line = evt.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          const t: string | undefined = obj?.type;

          const delta: string | undefined =
            obj.delta ?? obj.textDelta ?? (t === "text" ? obj.text : undefined);
          if (typeof delta === "string" && delta) {
            full += delta;
            onDelta?.(delta);
            continue;
          }

          if (t === "tool-input-available" && obj.toolCallId) {
            toolInputs.set(obj.toolCallId, { name: obj.toolName, input: obj.input });
          }
          if (t === "tool-output-available" && obj.toolCallId) {
            const meta = toolInputs.get(obj.toolCallId);
            handleToolResult(meta?.name, meta?.input, obj.output);
          }
        } catch {
          /* keepalive / non-JSON */
        }
      }
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      history.pop();
      throw new Error("interrupted");
    }
    throw err;
  } finally {
    if (inflight === ctrl) inflight = null;
  }

  const assistantMsg: HistoryMessage = {
    id: mkId(),
    role: "assistant",
    parts: [{ type: "text", text: full }],
  };
  history.push(assistantMsg);
  while (history.length > HISTORY_CAP) history.shift();
  // Persist the turn (fire-and-forget).
  try {
    void supabase.from("jarvis_interactions").insert({
      user_text: userText,
      assistant_text: full,
      provider: brain.provider,
      model: brain.model,
      mode: opts.mode ?? "text",
      latency_ms: Date.now() - startedAt,
      screenshot_url: opts.screenshotUrl ?? null,
    } as any);
  } catch { /* noop */ }
  return full.trim();
}

// ---- Tool result → side effects ---------------------------------------------

function handleToolResult(name: string | undefined, input: any, output: any) {
  if (!name || output == null) return;
  const add = useContent.getState().addCard;

  try {
    switch (name) {
      case "web_search": {
        const mode = output.mode === "news" ? "news" : "search";
        add({
          type: mode as any,
          title: mode === "news" ? "Latest news" : "Search results",
          query: output.query ?? input?.query ?? "",
          results: output.results ?? [],
        } as any);
        break;
      }
      case "weather": {
        if (output.error) {
          add({ type: "error", message: output.error } as any);
          break;
        }
        add({
          type: "weather",
          title: `Weather · ${output.location}`,
          location: output.location,
          current: output.current ?? {},
          hourly: {
            time: output.hourly_next_24h?.time ?? [],
            temperature: output.hourly_next_24h?.temperature ?? [],
            precipitation_probability: output.hourly_next_24h?.precipitation_probability ?? [],
          },
        } as any);
        break;
      }
      case "flight_search": {
        add({
          type: "flight",
          title: `${input?.origin ?? "?"} → ${input?.destination ?? "?"}`,
          note: output.needs_api ? "No flight API configured — showing web results." : "Web research",
          results: output.results ?? [],
        } as any);
        break;
      }
      case "remember": {
        add({ type: "memory", topic: output.topic ?? input?.topic ?? "", action: output.created ? "created" : "updated" } as any);
        break;
      }
      case "set_reminder": {
        if (output.scheduled) {
          add({ type: "reminder", text: input?.text ?? "reminder", fireAt: output.fire_at } as any);
        }
        break;
      }
      case "look_at_screen":
      case "look_at_camera": {
        const kind = name === "look_at_camera" ? "camera" : "screen";
        runVisionCapture(kind, output?.question ?? input?.question);
        break;
      }
      case "summarize_file": {
        if (output.error) add({ type: "error", message: `Summarize failed: ${output.error}` } as any);
        else add({ type: "file", filename: input?.signed_url?.split("/").pop() ?? "file", summary: output.summary ?? "" } as any);
        break;
      }
      case "navigate":
      case "add_inbox_item":
      case "open_project":
      case "focus_panel":
      case "switch_brain": {
        // None of these are persisted server-side — the browser performs the
        // one-and-only side effect (navigation/UI state, or for
        // add_inbox_item, the actual DB write).
        void runToolIntent(name, { action: name, ...(output ?? {}), ...(input ?? {}) });
        break;
      }
      case "create_task":
      case "create_note": {
        // Server-authoritative: jarvis-chat's tool handler already inserted
        // the row (service-role client, stamps user_id + source:"jarvis").
        // Do NOT call runToolIntent here — that used to insert a SECOND row
        // client-side (Round 3 fix for a silent-duplication bug). Just
        // report what the server already committed.
        const label = name === "create_task" ? "Task" : "Note";
        if (output?.error) {
          useUi.getState().push(`${label} failed — ${output.error}`, "err");
        } else {
          useUi.getState().push(`${label} ${name === "create_task" ? "created" : "saved"}: ${output?.title ?? input?.title ?? ""}`, "ok");
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.warn("handleToolResult failed", err);
  }
}

let lastVisionAt = 0;
async function runVisionCapture(kind: "screen" | "camera", question?: string) {
  const v = useVoice.getState();
  if (v.visionBusy) return;
  if (Date.now() - lastVisionAt < 4000) return;
  lastVisionAt = Date.now();
  v.setVisionBusy(true);
  const add = useContent.getState().addCard;
  const update = useContent.getState().updateCard;
  const cardId = add({ type: "vision", kind, thumbUrl: "", description: "Capturing…" } as any);
  try {
    const r = await captureAndDescribe(kind, question);
    update(cardId, { thumbUrl: r.thumbDataUrl, description: r.description } as any);
    try {
      await jarvisChat(`(vision:${kind}) ${r.description}`);
    } catch { /* noop */ }
  } catch (err: any) {
    update(cardId, { description: `Vision failed: ${err?.message ?? "error"}` } as any);
  } finally {
    v.setVisionBusy(false);
  }
}