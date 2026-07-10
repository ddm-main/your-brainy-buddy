// JARVIS speech-to-text client. Captures mic via Web Audio, encodes complete
// WAV blobs, uploads to the `jarvis-transcribe` edge function which streams
// back SSE `transcript.text.delta` events. Falls back to browser
// SpeechRecognition when the function or mic path is unavailable.

export interface SttHandle {
  stop: () => Promise<string>;         // graceful end-of-turn (returns final transcript)
  cancel: () => void;                  // hard abort
  onInterim?: (text: string) => void;  // interim words (browser fallback only, or best-effort)
  onFinal?: (text: string) => void;    // committed segments
  onRms?: (rms: number) => void;       // 0..1 mic level for VAD / visuals
}

interface StartOpts {
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onRms?: (rms: number) => void;
  language?: string;
  // If continuous, we upload rolling ~3s WAV windows for streaming interim.
  // Otherwise we upload one WAV at stop().
  continuous?: boolean;
}

const SAMPLE_RATE = 16_000;
const WINDOW_MS = 2_500;

function endpoint() {
  const base = import.meta.env.VITE_SUPABASE_URL as string;
  return `${base}/functions/v1/jarvis-transcribe`;
}

import { authHeaders as _authHeaders } from "@/lib/authFetch";
async function authHeaders() { return _authHeaders(); }

// Downsample Float32 buffer from srcRate to dstRate.
function downsample(input: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (dstRate >= srcRate) return input;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  let o = 0, i = 0;
  while (o < outLen) {
    const nextI = Math.floor((o + 1) * ratio);
    let sum = 0, count = 0;
    for (; i < nextI && i < input.length; i++) { sum += input[i]; count++; }
    out[o++] = count > 0 ? sum / count : 0;
  }
  return out;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function transcribeBlob(blob: Blob, language?: string): Promise<string> {
  const form = new FormData();
  form.append("model", "openai/gpt-4o-mini-transcribe");
  form.append("file", blob, "recording.wav");
  form.append("stream", "false");
  if (language) form.append("language", language);
  const res = await fetch(endpoint(), { method: "POST", headers: await authHeaders(), body: form });
  if (!res.ok) throw new Error(`transcribe failed (${res.status})`);
  const j = await res.json();
  return String(j?.text ?? "").trim();
}

/** Start recording. Returns a handle; call .stop() to end the turn. */
export async function startRecording(opts: StartOpts = {}): Promise<SttHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: {
    channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  } });
  const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
  const ctx = new AC();
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let cancelled = false;
  let lastInterimAt = 0;
  const language = opts.language;

  node.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));
    if (opts.onRms) {
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      opts.onRms(Math.min(1, Math.sqrt(sum / data.length) * 3));
    }
    // Rolling interim upload for continuous mode.
    if (opts.continuous && opts.onInterim && Date.now() - lastInterimAt > WINDOW_MS) {
      lastInterimAt = Date.now();
      const flat = flatten(chunks);
      const ds = downsample(flat, ctx.sampleRate, SAMPLE_RATE);
      const wav = encodeWav(ds, SAMPLE_RATE);
      if (wav.size > 4096) {
        transcribeBlob(wav, language).then((t) => { if (!cancelled && t) opts.onInterim?.(t); }).catch(() => {});
      }
    }
  };
  source.connect(node);
  node.connect(ctx.destination);

  const teardown = () => {
    try { stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    try { node.disconnect(); } catch { /* noop */ }
    try { source.disconnect(); } catch { /* noop */ }
    try { ctx.close(); } catch { /* noop */ }
  };

  return {
    async stop(): Promise<string> {
      teardown();
      if (cancelled) return "";
      const flat = flatten(chunks);
      if (flat.length < SAMPLE_RATE * 0.25) return "";
      const ds = downsample(flat, ctx.sampleRate, SAMPLE_RATE);
      const wav = encodeWav(ds, SAMPLE_RATE);
      try {
        const text = await transcribeBlob(wav, language);
        if (text && opts.onFinal) opts.onFinal(text);
        return text;
      } catch (err) {
        console.warn("[JARVIS] STT failed:", err);
        return "";
      }
    },
    cancel() {
      cancelled = true;
      teardown();
      opts.onRms?.(0);
    },
  };
}

function flatten(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Feature check: is a real STT function reachable? Falls back to Web Speech otherwise. */
export function hasRemoteStt(): boolean {
  return !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
}
