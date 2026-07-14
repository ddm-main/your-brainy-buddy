import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Pause, Play, Square, Volume2, Paperclip, Ban, ChevronDown } from "lucide-react";
import { useVoice, VOICE_STYLES, type VoiceLanguage, type VoiceStyleId } from "@/store/voiceStore";
import { motion, AnimatePresence } from "framer-motion";
import { jarvisChat, abortJarvisStream } from "@/lib/jarvisChat";
import { useContent } from "@/store/contentStore";
import { speakStream, stopSpeaking, primeAudio } from "@/lib/tts";
import { supabase as _supabase } from "@/integrations/supabase/client";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = _supabase as any;
import { useUi } from "@/store/uiStore";

const LANG_LABEL: Record<VoiceLanguage, string> = {
  "en-IN": "EN",
  "hi-IN": "HI",
  "mr-IN": "MR",
};

export default function VoiceBar() {
  const {
    state, continuous, transcript, interim, lastAnswer, amplitude, showTranscript,
    language, voiceStyle,
    setState, toggleContinuous, toggleTranscript, setAmplitude, setTranscript, setInterim, reset,
    setLanguage, setVoiceStyle,
  } = useVoice();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const conversationOpen = useUi((s) => s.conversationOpen);
  const [styleOpen, setStyleOpen] = useState(false);

  const interrupt = () => {
    abortJarvisStream();
    stopSpeaking();
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    useVoice.getState().markActivity();
    useVoice.getState().interrupt();
  };

  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (state !== "listening") {
      cancelAnimationFrame(rafRef.current);
      setAmplitude(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
        const ctx = new AC();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        analyserRef.current = analyser;
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          setAmplitude(Math.min(1, rms * 3));
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch (err: unknown) {
        const name = (err as { name?: string })?.name ?? "";
        const msg = name === "NotAllowedError"
          ? "Microphone permission denied. Enable it in your browser settings."
          : name === "NotFoundError"
            ? "No microphone found."
            : "Could not access the microphone.";
        useUi.getState().push(msg, "err");
        useVoice.getState().setError(msg);
        setState("idle");
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [state, setAmplitude, setState]);

  // Web Speech recognition — restarts when language changes.
  const pendingRef = useRef<string>("");
  const flushTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (state !== "listening") return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      console.warn("SpeechRecognition not supported in this browser");
      return;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = language;
    let stopped = false;

    const speakStyle = () => {
      const s = VOICE_STYLES[useVoice.getState().voiceStyle];
      return { voice: s.voice, instructions: s.instructions };
    };

    const flush = async () => {
      const text = pendingRef.current.trim();
      pendingRef.current = "";
      if (!text) return;
      try { rec.stop(); } catch { /* noop */ }
      useVoice.getState().setState("processing");
      useVoice.getState().markActivity();
      try {
        const reply = await jarvisChat(text);
        if (useVoice.getState().state !== "processing") return;
        useVoice.getState().setAnswer(reply);
        useVoice.getState().setState("speaking");
        void speakStream(reply, () => {
          const s = useVoice.getState();
          if (s.continuous && s.state === "speaking") s.setState("listening");
          else if (s.state === "speaking") s.setState("idle");
        }, speakStyle());
      } catch (err: unknown) {
        const msg = (err as { message?: string })?.message ?? "error";
        if (msg !== "interrupted") {
          console.error(err);
          useUi.getState().push(`JARVIS: ${msg}`, "err");
          useVoice.getState().setAnswer(`[${msg}]`);
        }
        useVoice.getState().setState(useVoice.getState().continuous ? "listening" : "idle");
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      let final = "";
      let inter = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else inter += r[0].transcript;
      }
      if (final) {
        pendingRef.current = (pendingRef.current + " " + final).trim();
        setTranscript(pendingRef.current);
      }
      setInterim(inter);
      if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
      if (pendingRef.current) {
        flushTimerRef.current = window.setTimeout(flush, 900);
      }
    };
    rec.onend = () => {
      if (stopped) return;
      const s = useVoice.getState().state;
      if (s === "listening") {
        try { rec.start(); } catch { /* noop */ }
      }
    };
    rec.onerror = () => { /* swallow */ };
    try { rec.start(); } catch { /* noop */ }
    return () => {
      stopped = true;
      if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
      try { rec.stop(); } catch { /* noop */ }
    };
  }, [state, language, setInterim, setTranscript]);

  useEffect(() => {
    if (state === "idle" || state === "muted") {
      try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    }
  }, [state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); interrupt(); return; }
      if (e.code === "Space" && e.target === document.body) {
        e.preventDefault();
        void primeAudio();
        if (state === "idle") setState("listening");
        else if (state === "listening") setState("idle");
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        useUi.getState().openConversation();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, setState]);

  const stateColor: Record<string, string> = {
    idle: "var(--text-dim)",
    listening: "var(--accent)",
    processing: "var(--warn)",
    speaking: "var(--ok)",
    paused: "var(--text-dim)",
    muted: "var(--danger)",
  };

  if (conversationOpen) return null;

  const currentStyle = VOICE_STYLES[voiceStyle];

  return (
    <div className="voice-dock">
      <div className="voice-dock-row">
        <button
          onClick={async () => {
            await primeAudio();
            useVoice.getState().setError(null);
            setState(state === "listening" ? "idle" : "listening");
          }}
          className="focus-outline voice-mic"
          data-active={state === "listening"}
          title={state === "listening" ? "Stop listening (Space)" : "Start listening (Space)"}
        >
          {state === "muted" ? <MicOff size={14} /> : <Mic size={14} />}
        </button>

        <div className="voice-chips">
          {(Object.keys(LANG_LABEL) as VoiceLanguage[]).map((l) => (
            <button
              key={l}
              onClick={() => setLanguage(l)}
              className="voice-chip"
              data-active={language === l}
              title={l}
            >
              {LANG_LABEL[l]}
            </button>
          ))}
        </div>

        <div className="voice-style">
          <button
            onClick={() => setStyleOpen((v) => !v)}
            className="voice-chip voice-chip-wide"
            title="Voice style"
          >
            {currentStyle.label} <ChevronDown size={10} />
          </button>
          {styleOpen && (
            <div className="voice-style-menu" onMouseLeave={() => setStyleOpen(false)}>
              {(Object.keys(VOICE_STYLES) as VoiceStyleId[]).map((id) => (
                <button
                  key={id}
                  onClick={() => { setVoiceStyle(id); setStyleOpen(false); }}
                  className="voice-style-item"
                  data-active={voiceStyle === id}
                >
                  {VOICE_STYLES[id].label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="voice-wave">
          <Waveform amplitude={amplitude} active={state === "listening"} />
        </div>

        <div className="voice-state">
          <span
            className={`live-dot ${state === "idle" ? "idle" : state === "muted" ? "err" : ""}`}
            style={{ color: stateColor[state], background: stateColor[state] }}
          />
          <span className="hud-label" style={{ color: stateColor[state], fontSize: 10 }}>{state}</span>
        </div>
      </div>

      <div className="voice-dock-row voice-dock-row-secondary">
        <button onClick={toggleContinuous} className="focus-outline voice-chip" data-active={continuous} title="Toggle continuous">
          {continuous ? <Play size={10} /> : <Pause size={10} />} {continuous ? "auto" : "push"}
        </button>
        <button onClick={reset} className="focus-outline voice-chip" title="Stop"><Square size={10} /> stop</button>
        <button onClick={interrupt} className="focus-outline voice-chip" title="Interrupt (Esc)"><Ban size={10} /> stop-tts</button>
        <button
          onClick={() => setState(state === "muted" ? "idle" : "muted")}
          className="focus-outline voice-chip"
          data-active={state === "muted"}
          title="Mute microphone"
        >
          {state === "muted" ? <MicOff size={10} /> : <Mic size={10} />} {state === "muted" ? "unmute" : "mute"}
        </button>
        <button onClick={() => fileRef.current?.click()} className="focus-outline voice-chip" title="Attach file">
          <Paperclip size={10} /> file
        </button>
        <button onClick={toggleTranscript} className="focus-outline voice-chip" data-active={showTranscript} title="Transcript">
          <Volume2 size={10} /> log
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf,text/plain"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.currentTarget.value = "";
            if (!f) return;
            useContent.getState().addCard({ type: "file", filename: f.name, summary: "Reading…" } as never);
            try {
              if (f.type.startsWith("text/")) {
                const text = await f.text();
                await jarvisChat(`Please summarize this file (${f.name}):\n\n${text.slice(0, 20_000)}`);
              } else {
                const bytesBase64 = await fileToBase64(f);
                const { data, error } = await supabase.functions.invoke("jarvis-vision-upload", {
                  body: { filename: f.name, contentType: f.type || "application/octet-stream", bytesBase64 },
                });
                if (error || !data?.url) throw new Error(error?.message ?? "upload failed");
                await jarvisChat(
                  `I've uploaded a file. Call summarize_file with signed_url="${data.url}" and mime="${f.type || "application/octet-stream"}" to summarize it. Filename: ${f.name}.`,
                );
              }
            } catch (err: unknown) {
              const m = (err as { message?: string })?.message ?? "error";
              useUi.getState().push(`File failed: ${m}`, "err");
              useContent.getState().addCard({ type: "error", message: `File failed: ${m}` } as never);
            }
          }}
        />
      </div>

      <AnimatePresence>
        {(interim || transcript || lastAnswer) && (
          <motion.div
            key={interim + transcript + lastAnswer}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="voice-transcript"
          >
            {interim ? <em style={{ color: "var(--accent-soft)" }}>› {interim}</em> :
             transcript ? <span>› {transcript}</span> :
             <span style={{ color: "var(--ok)" }}>⤺ {lastAnswer}</span>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? "");
      const idx = s.indexOf(",");
      resolve(idx >= 0 ? s.slice(idx + 1) : s);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

function Waveform({ amplitude, active }: { amplitude: number; active: boolean }) {
  const bars = 20;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, height: 22 }}>
      {Array.from({ length: bars }).map((_, i) => {
        const base = active ? 0.15 + amplitude * (0.4 + Math.sin(i * 0.7 + Date.now() * 0.005) * 0.4) : 0.1;
        return (
          <motion.span
            key={i}
            animate={{ height: `${Math.max(3, base * 20)}px` }}
            transition={{ duration: 0.08 }}
            style={{
              width: 2,
              background: active ? "var(--accent)" : "var(--text-muted)",
              boxShadow: active ? "0 0 4px var(--accent)" : "none",
            }}
          />
        );
      })}
    </div>
  );
}
