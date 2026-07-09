import { useEffect, useRef } from "react";
import { Mic, MicOff, Pause, Play, Square, Volume2, Paperclip, Ban } from "lucide-react";
import { useVoice } from "@/store/voiceStore";
import { motion, AnimatePresence } from "framer-motion";
import { jarvisChat, abortJarvisStream } from "@/lib/jarvisChat";
import { useContent } from "@/store/contentStore";
import { supabase } from "@/integrations/supabase/client";
import { useUi } from "@/store/uiStore";

export default function VoiceBar() {
  const {
    state, continuous, transcript, interim, lastAnswer, amplitude, showTranscript,
    setState, toggleContinuous, toggleTranscript, setAmplitude, setTranscript, setInterim, reset,
  } = useVoice();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const interrupt = () => {
    abortJarvisStream();
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    useVoice.getState().markActivity();
    useVoice.getState().interrupt();
  };

  // Language auto-detect: cycle first 3 utterances across candidates, keep highest confidence.
  const LANG_KEY = "jarvis.lang";
  const langCandidates = ["en-IN", "hi-IN", "mr-IN"] as const;
  const langRef = useRef<string>(
    (typeof localStorage !== "undefined" && localStorage.getItem(LANG_KEY)) || "en-IN",
  );
  const langLockedRef = useRef<boolean>(
    typeof localStorage !== "undefined" && !!localStorage.getItem(LANG_KEY),
  );
  const langSamplesRef = useRef<{ lang: string; conf: number }[]>([]);

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
      } catch {
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

  // Web Speech API — continuous listen, debounced flush → LLM → TTS
  const pendingRef = useRef<string>("");
  const flushTimerRef = useRef<number | null>(null);
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    if (state !== "listening") return;
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      console.warn("SpeechRecognition not supported in this browser");
      return;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = langRef.current;
    let stopped = false;

    const flush = async () => {
      const text = pendingRef.current.trim();
      pendingRef.current = "";
      if (!text) return;
      try { rec.stop(); } catch {}
      useVoice.getState().setState("processing");
      useVoice.getState().markActivity();
      try {
        const reply = await jarvisChat(text);
        if (useVoice.getState().state !== "processing") return; // user interrupted
        useVoice.getState().setAnswer(reply);
        useVoice.getState().setState("speaking");
        speakChunked(reply, () => {
          const s = useVoice.getState();
          if (s.continuous && s.state === "speaking") s.setState("listening");
          else if (s.state === "speaking") s.setState("idle");
        });
      } catch (err: any) {
        const msg = err?.message ?? "error";
        if (msg !== "interrupted") {
          console.error(err);
          useUi.getState().push(`JARVIS: ${msg}`, "err");
          useVoice.getState().setAnswer(`[${msg}]`);
        }
        useVoice.getState().setState(useVoice.getState().continuous ? "listening" : "idle");
      }
    };

    rec.onresult = (e: any) => {
      let final = "";
      let inter = "";
      let finalConf = 0;
      let finalCount = 0;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          final += r[0].transcript;
          finalConf += Number(r[0].confidence) || 0;
          finalCount++;
        } else inter += r[0].transcript;
      }
      if (final) {
        pendingRef.current = (pendingRef.current + " " + final).trim();
        setTranscript(pendingRef.current);
        // Sample confidence for language detection until locked.
        if (!langLockedRef.current && finalCount > 0) {
          langSamplesRef.current.push({
            lang: langRef.current,
            conf: finalConf / finalCount,
          });
          if (langSamplesRef.current.length >= langCandidates.length) {
            // Pick the winner
            const best = langSamplesRef.current.reduce((a, b) => (b.conf > a.conf ? b : a));
            langRef.current = best.lang;
            langLockedRef.current = true;
            try { localStorage.setItem(LANG_KEY, best.lang); } catch { /* noop */ }
            jarvisChat(`(system) remember preferences.language = ${best.lang}`).catch(() => {});
          } else {
            // Rotate to the next candidate and restart the recognizer
            const idx = langSamplesRef.current.length % langCandidates.length;
            langRef.current = langCandidates[idx];
            try { rec.stop(); } catch { /* onend will restart with new lang */ }
          }
        }
      }
      setInterim(inter);
      // debounce: flush after 900ms of no new speech
      if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
      if (pendingRef.current) {
        flushTimerRef.current = window.setTimeout(flush, 900);
      }
    };
    rec.onend = () => {
      if (stopped) return;
      // keep listening while state is "listening"
      if (useVoice.getState().state === "listening") {
        try { rec.lang = langRef.current; } catch { /* noop */ }
        try { rec.start(); } catch { /* noop */ }
      }
    };
    rec.onerror = () => { /* swallow no-speech / network — onend will retry */ };
    try { rec.start(); } catch { /* noop */ }
    return () => {
      stopped = true;
      if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
      try { rec.stop(); } catch {}
    };
  }, [state, setInterim, setTranscript]);

  // Cancel any speech when user stops
  useEffect(() => {
    if (state === "idle" || state === "muted") {
      try { window.speechSynthesis?.cancel(); } catch {}
    }
  }, [state]);

  function speakChunked(text: string, onDone: () => void) {
    const synth = window.speechSynthesis;
    if (!synth) { onDone(); return; }
    synth.cancel();
    // Split into ~50-word phrases at sentence/clause boundaries so INTERRUPT
    // lands within one phrase instead of the whole reply.
    const chunks = chunkForSpeech(text, 50);
    if (!chunks.length) { onDone(); return; }
    const voices = synth.getVoices();
    const preferred = voices.find((v) => /uk|british|daniel|google uk english male/i.test(v.name))
      ?? voices.find((v) => /male/i.test(v.name))
      ?? voices.find((v) => v.lang?.startsWith("en"));
    let i = 0;
    const speakNext = () => {
      if (i >= chunks.length) { onDone(); return; }
      if (useVoice.getState().state !== "speaking") { onDone(); return; }
      const u = new SpeechSynthesisUtterance(chunks[i++]);
      u.rate = 1.05;
      u.pitch = 0.9;
      if (preferred) u.voice = preferred;
      u.onend = speakNext;
      u.onerror = speakNext;
      utterRef.current = u;
      synth.speak(u);
    };
    speakNext();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        interrupt();
        return;
      }
      if (e.code === "Space" && e.target === document.body) {
        e.preventDefault();
        if (state === "idle") setState("listening");
        else if (state === "listening") setState("idle");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, setState]);

  // Idle watcher — proactive check-in after 15 min of true idle.
  useEffect(() => {
    const iv = window.setInterval(() => {
      const s = useVoice.getState();
      if (s.state !== "idle") return;
      if (document.visibilityState !== "visible") return;
      if (Date.now() - s.lastActivity < 15 * 60_000) return;
      s.markActivity(); // prevent re-fire loop
      jarvisChat("(system) 15-minute idle check-in — one short helpful nudge for Deepak, no fluff.")
        .then((reply) => {
          if (!reply) return;
          useVoice.getState().setAnswer(reply);
          useVoice.getState().setState("speaking");
          speakChunked(reply, () => {
            const st = useVoice.getState();
            if (st.state === "speaking") st.setState(st.continuous ? "listening" : "idle");
          });
        })
        .catch(() => { /* silent */ });
    }, 60_000);
    const bump = () => useVoice.getState().markActivity();
    window.addEventListener("pointerdown", bump);
    window.addEventListener("keydown", bump);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("keydown", bump);
    };
  }, []);


  const stateColor: Record<string, string> = {
    idle: "var(--text-dim)",
    listening: "var(--accent)",
    processing: "var(--warn)",
    speaking: "var(--ok)",
    paused: "var(--text-dim)",
    muted: "var(--danger)",
  };

  return (
    <footer style={{
      borderTop: "1px solid var(--edge)",
      background: "rgba(5, 10, 20, 0.75)",
      backdropFilter: "blur(20px)",
      padding: "10px 20px",
      display: "flex", alignItems: "center", gap: 16,
      zIndex: 10,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={() => setState(state === "listening" ? "idle" : "listening")}
          className="focus-outline"
          style={{
            width: 40, height: 40, borderRadius: "50%",
            border: `1px solid ${state === "listening" ? "var(--accent)" : "var(--edge)"}`,
            background: state === "listening" ? "rgba(53, 214, 237, 0.15)" : "transparent",
            color: state === "listening" ? "var(--accent)" : "var(--text-dim)",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: state === "listening" ? "0 0 20px rgba(53, 214, 237, 0.4)" : "none",
            transition: "all 250ms",
          }}
          title={state === "listening" ? "Stop listening (Space)" : "Start listening (Space)"}
        >
          {state === "muted" ? <MicOff size={16} /> : <Mic size={16} />}
        </button>
        <button
          onClick={toggleContinuous}
          className="focus-outline"
          style={pillStyle(continuous)}
          title="Toggle continuous conversation"
        >
          {continuous ? <Play size={11} /> : <Pause size={11} />}
          {continuous ? "continuous" : "push-to-talk"}
        </button>
        <button onClick={reset} className="focus-outline" style={pillStyle(false)} title="Stop">
          <Square size={11} /> stop
        </button>
        <button onClick={interrupt} className="focus-outline" style={pillStyle(false)} title="Interrupt (Esc)">
          <Ban size={11} /> interrupt
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          className="focus-outline"
          style={pillStyle(false)}
          title="Attach file to summarize"
        >
          <Paperclip size={11} /> file
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
            useContent.getState().addCard({ type: "file", filename: f.name, summary: "Reading…" } as any);
            try {
              if (f.type.startsWith("text/")) {
                const text = await f.text();
                await jarvisChat(`Please summarize this file (${f.name}):\n\n${text.slice(0, 20_000)}`);
              } else {
                // Upload binary to signed storage, then let the summarize_file tool fetch it.
                const bytesBase64 = await fileToBase64(f);
                const { data, error } = await supabase.functions.invoke("jarvis-vision-upload", {
                  body: { filename: f.name, contentType: f.type || "application/octet-stream", bytesBase64 },
                });
                if (error || !data?.url) throw new Error(error?.message ?? "upload failed");
                await jarvisChat(
                  `I've uploaded a file. Call summarize_file with signed_url="${data.url}" and mime="${f.type || "application/octet-stream"}" to summarize it. Filename: ${f.name}.`,
                );
              }
            } catch (err: any) {
              useUi.getState().push(`File failed: ${err?.message ?? "error"}`, "err");
              useContent.getState().addCard({ type: "error", message: `File failed: ${err?.message ?? "error"}` } as any);
            }
          }}
        />
      </div>

      <Waveform amplitude={amplitude} active={state === "listening"} />

      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 90 }}>
        <span className={`live-dot ${state === "idle" ? "idle" : state === "muted" ? "err" : ""}`}
          style={{ color: stateColor[state] as any, background: stateColor[state] as any }} />
        <span className="hud-label" style={{ color: stateColor[state], fontSize: 10 }}>
          {state}
        </span>
      </div>

      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        <AnimatePresence mode="wait">
          {(interim || transcript || lastAnswer) && (
            <motion.div
              key={interim + transcript + lastAnswer}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-hud)", letterSpacing: "0.04em", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}
            >
              {interim ? <em style={{ color: "var(--accent-soft)" }}>› {interim}</em> :
               transcript ? <span>› {transcript}</span> :
               <span style={{ color: "var(--ok)" }}>⤺ {lastAnswer}</span>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <button onClick={toggleTranscript} style={pillStyle(showTranscript)} title="Transcript">
        <Volume2 size={11} /> transcript
      </button>
    </footer>
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

function pillStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: 5,
    padding: "5px 10px",
    border: `1px solid ${active ? "var(--edge-strong)" : "var(--edge)"}`,
    color: active ? "var(--accent)" : "var(--text-dim)",
    background: active ? "rgba(53, 214, 237, 0.06)" : "transparent",
    fontSize: 10, fontFamily: "var(--font-hud)", letterSpacing: "0.16em",
    textTransform: "uppercase", borderRadius: 2, transition: "all 200ms",
  };
}

function chunkForSpeech(text: string, maxWords: number): string[] {
  const parts = text.split(/(?<=[.!?])\s+/).flatMap((s) => s.split(/(?<=[,;:])\s+/));
  const out: string[] = [];
  let buf = "";
  let words = 0;
  for (const p of parts) {
    const pw = p.split(/\s+/).length;
    if (words + pw > maxWords && buf) {
      out.push(buf.trim());
      buf = p;
      words = pw;
    } else {
      buf = buf ? `${buf} ${p}` : p;
      words += pw;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function Waveform({ amplitude, active }: { amplitude: number; active: boolean }) {
  const bars = 24;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, height: 24 }}>
      {Array.from({ length: bars }).map((_, i) => {
        const base = active ? 0.15 + amplitude * (0.4 + Math.sin(i * 0.7 + Date.now() * 0.005) * 0.4) : 0.1;
        return (
          <motion.span
            key={i}
            animate={{ height: `${Math.max(3, base * 22)}px` }}
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
