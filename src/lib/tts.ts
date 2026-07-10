// Streaming TTS client — talks to the `jarvis-tts` edge function which returns
// SSE events carrying base64 PCM chunks. Chunks are scheduled on a shared
// AudioContext for gapless playback. `stopSpeaking()` cancels the in-flight
// request AND every scheduled buffer for instant barge-in.

let ctx: AudioContext | null = null;
let currentAbort: AbortController | null = null;
let scheduledSources: AudioBufferSourceNode[] = [];
let playhead = 0;
let onEndCb: (() => void) | null = null;

function getCtx(): AudioContext {
  if (!ctx) {
    const AC = (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext) as typeof AudioContext;
    ctx = new AC({ sampleRate: 24000 });
  }
  return ctx;
}

export function stopSpeaking(): void {
  try { currentAbort?.abort(); } catch { /* noop */ }
  currentAbort = null;
  for (const s of scheduledSources) {
    try { s.stop(); } catch { /* noop */ }
    try { s.disconnect(); } catch { /* noop */ }
  }
  scheduledSources = [];
  playhead = 0;
  const cb = onEndCb;
  onEndCb = null;
  cb?.();
}

export async function speakStream(text: string, onDone?: () => void): Promise<void> {
  const clean = text.replace(/```[\s\S]*?```/g, " ").replace(/[#*_>`~]/g, "").trim();
  if (!clean) { onDone?.(); return; }

  stopSpeaking();
  onEndCb = onDone ?? null;

  const c = getCtx();
  if (c.state === "suspended") { try { await c.resume(); } catch { /* noop */ } }
  playhead = 0;
  let pending = new Uint8Array(0);

  const schedule = (incoming: Uint8Array) => {
    const combined = new Uint8Array(pending.length + incoming.length);
    combined.set(pending); combined.set(incoming, pending.length);
    const usable = combined.length - (combined.length % 2);
    pending = combined.slice(usable);
    if (usable === 0) return;
    const samples = new Int16Array(combined.buffer, 0, usable / 2);
    const floats = Float32Array.from(samples, (s) => s / 32768);
    const buffer = c.createBuffer(1, floats.length, 24000);
    buffer.copyToChannel(floats, 0);
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.connect(c.destination);
    if (playhead === 0) playhead = c.currentTime + 0.06;
    else playhead = Math.max(playhead, c.currentTime);
    source.start(playhead);
    playhead += buffer.duration;
    scheduledSources.push(source);
  };

  const ctrl = new AbortController();
  currentAbort = ctrl;
  const base = import.meta.env.VITE_SUPABASE_URL as string;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

  let res: Response;
  try {
    res = await fetch(`${base}/functions/v1/jarvis-tts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        apikey: key,
      },
      body: JSON.stringify({ text: clean }),
      signal: ctrl.signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") return;
    console.warn("[JARVIS] TTS network error, falling back:", err);
    fallbackSpeak(clean, onDone);
    return;
  }

  if (!res.ok || !res.body) {
    console.warn("[JARVIS] TTS bad response, falling back:", res.status);
    fallbackSpeak(clean, onDone);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const evt of events) {
        const line = evt.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          if (obj?.type === "speech.audio.delta" && obj.audio) {
            const bin = atob(obj.audio);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            schedule(bytes);
          }
        } catch { /* keepalive */ }
      }
    }
  } catch (err: any) {
    if (err?.name === "AbortError") return;
    console.warn("[JARVIS] TTS stream error:", err);
  }

  // Fire onDone after last scheduled chunk finishes.
  const remainingMs = Math.max(0, (playhead - c.currentTime) * 1000);
  window.setTimeout(() => {
    if (currentAbort === ctrl) {
      currentAbort = null;
      const cb = onEndCb;
      onEndCb = null;
      cb?.();
    }
  }, remainingMs + 40);
}

// Browser SpeechSynthesis fallback used when the TTS function is unavailable.
function fallbackSpeak(text: string, onDone?: () => void) {
  const synth = window.speechSynthesis;
  if (!synth) { onDone?.(); return; }
  try { synth.cancel(); } catch { /* noop */ }
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05; u.pitch = 0.9;
  const voices = synth.getVoices();
  const preferred = voices.find((v) => /uk|british|daniel|google uk english male/i.test(v.name))
    ?? voices.find((v) => v.lang?.startsWith("en"));
  if (preferred) u.voice = preferred;
  u.onend = () => onDone?.();
  u.onerror = () => onDone?.();
  synth.speak(u);
}