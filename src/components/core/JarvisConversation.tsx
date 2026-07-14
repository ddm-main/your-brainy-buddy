import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import { Mic, MicOff, X, Ban, Play, Pause, Monitor, MonitorOff, History, Send } from "lucide-react";
import { useUi } from "@/store/uiStore";
import { useVoice } from "@/store/voiceStore";
import { useBrain, currentBrainLabel } from "@/store/brainStore";
import { jarvisChat, abortJarvisStream } from "@/lib/jarvisChat";
import { speakStream, stopSpeaking } from "@/lib/tts";
import { startRecording, type SttHandle } from "@/lib/stt";
import { supabase as _supabase } from "@/integrations/supabase/client";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = _supabase as any;
import BrainPicker from "./BrainPicker";
import JarvisCore from "./JarvisCore";
import { startShare, stopShare, captureShareFrame, onScreenShareChange, isSharing } from "@/lib/screenShare";

interface HistoryRow {
  id: string;
  created_at: string;
  user_text: string;
  assistant_text: string;
  provider: string;
  model: string;
}

const STATES = ["idle", "listening", "processing", "speaking", "muted"] as const;
const STATE_LABEL: Record<string, string> = {
  idle: "idle", listening: "listening", processing: "thinking",
  speaking: "speaking", muted: "muted", paused: "paused",
};
const STATE_COLOR: Record<string, string> = {
  idle: "var(--text-dim)", listening: "var(--accent)",
  processing: "var(--warn)", speaking: "var(--ok)",
  muted: "var(--danger)", paused: "var(--text-dim)",
};

export default function JarvisConversation() {
  const open = useUi((s) => s.conversationOpen);
  const closeRaw = useUi((s) => s.closeConversation);
  const push = useUi((s) => s.push);
  const state = useVoice((s) => s.state);
  const continuous = useVoice((s) => s.continuous);
  const transcript = useVoice((s) => s.transcript);
  const interim = useVoice((s) => s.interim);
  const amplitude = useVoice((s) => s.amplitude);
  const setState = useVoice((s) => s.setState);
  const toggleContinuous = useVoice((s) => s.toggleContinuous);
  const setTranscript = useVoice((s) => s.setTranscript);
  const setInterim = useVoice((s) => s.setInterim);
  const brain = useBrain();
  const brainLabel = currentBrainLabel(brain.provider, brain.model);

  const [reply, setReply] = useState("");
  const [typed, setTyped] = useState("");
  const [sharing, setSharing] = useState(isSharing());
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const sttRef = useRef<SttHandle | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const bargeTimerRef = useRef<number | null>(null);
  const runTurnRef = useRef<((text: string) => Promise<void>) | null>(null);

  // Unified interrupt: cancels chat stream + TTS + STT + speechSynthesis in one action.
  const hardInterrupt = () => {
    try { abortJarvisStream(); } catch { /* noop */ }
    stopSpeaking();
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    sttRef.current?.cancel();
    sttRef.current = null;
    if (silenceTimerRef.current) { window.clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    useVoice.getState().setInterim("");
    useVoice.getState().setAmplitude(0);
  };

  const close = () => {
    hardInterrupt();
    useVoice.getState().setState("idle");
    closeRaw();
  };

  useEffect(() => { const off = onScreenShareChange(setSharing); return () => { off; }; }, []);

  // Auto-start listening on open
  useEffect(() => {
    if (open && state === "idle") setState("listening");
    if (!open) hardInterrupt();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // ESC: interrupt (or close when idle)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      const s = useVoice.getState().state;
      if (s === "processing" || s === "speaking") {
        hardInterrupt();
        useVoice.getState().setState(useVoice.getState().continuous ? "listening" : "idle");
      } else {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // The turn runner: send text → stream reply → speak → auto-resume mic in continuous mode.
  runTurnRef.current = async (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    setTranscript(clean);
    setInterim("");
    setReply("");
    useVoice.getState().setState("processing");

    let screenshotUrl: string | undefined;
    if (isSharing()) {
      try { const { url } = await captureShareFrame(); screenshotUrl = url; }
      catch (err: any) { push(`Screenshot failed: ${err?.message ?? err}`, "warn"); }
    }

    try {
      const full = await jarvisChat(clean, (d) => setReply((r) => r + d), {
        mode: screenshotUrl ? "screen" : "voice",
        screenshotUrl,
      });
      if (useVoice.getState().state !== "processing") return;
      useVoice.getState().setAnswer(full);
      useVoice.getState().setState("speaking");
      const { VOICE_STYLES } = await import("@/store/voiceStore");
      const st = VOICE_STYLES[useVoice.getState().voiceStyle];
      speakStream(full, () => {
        const s = useVoice.getState();
        if (s.state !== "speaking") return;
        s.setState(s.continuous ? "listening" : "idle");
      }, { voice: st.voice, instructions: st.instructions });
      loadHistory();
    } catch (err: any) {
      const msg = err?.message ?? "error";
      if (msg !== "interrupted") push(`JARVIS: ${msg}`, "err");
      useVoice.getState().setState(useVoice.getState().continuous ? "listening" : "idle");
    }
  };

  // Mic capture — remote STT via jarvis-transcribe. VAD ends turn on 1.2s silence.
  useEffect(() => {
    if (!open || state !== "listening") return;
    let cancelled = false;
    let handle: SttHandle | null = null;
    (async () => {
      try {
        handle = await startRecording({
          continuous: true,
          language: localStorage.getItem("jarvis.lang") || undefined,
          onInterim: (t) => { if (!cancelled) setInterim(t); },
          onRms: (rms) => {
            if (cancelled) return;
            useVoice.getState().setAmplitude(rms);
            // VAD end-of-turn: 1.2s under threshold after we've heard something.
            const threshold = 0.06;
            const hasSpeech = (useVoice.getState().interim?.length ?? 0) > 2;
            if (rms > threshold) {
              if (silenceTimerRef.current) { window.clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
            } else if (hasSpeech && !silenceTimerRef.current) {
              silenceTimerRef.current = window.setTimeout(async () => {
                silenceTimerRef.current = null;
                if (cancelled) return;
                const h = sttRef.current; sttRef.current = null;
                const text = h ? await h.stop() : "";
                if (text) runTurnRef.current?.(text);
                else useVoice.getState().setState("listening");
              }, 1200);
            }
          },
        });
        if (cancelled) { handle.cancel(); return; }
        sttRef.current = handle;
      } catch (err: any) {
        const name = err?.name ?? "";
        const msg = name === "NotAllowedError"
          ? "Microphone permission denied. Enable it in your browser settings."
          : `Mic error: ${err?.message ?? err}`;
        push(msg, "err");
        useVoice.getState().setState("idle");
      }
    })();
    return () => {
      cancelled = true;
      if (silenceTimerRef.current) { window.clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
      handle?.cancel();
      if (sttRef.current === handle) sttRef.current = null;
      useVoice.getState().setAmplitude(0);
    };
  }, [open, state, push, setInterim]);

  // Barge-in: while JARVIS is speaking, monitor mic RMS; if the user speaks, cancel TTS
  // and switch to listening. Uses a lightweight analyser separate from STT capture.
  useEffect(() => {
    if (!open || state !== "speaking") return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
        ctx = new AC();
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser(); an.fftSize = 512;
        src.connect(an);
        const buf = new Uint8Array(an.frequencyBinCount);
        let over = 0;
        const tick = () => {
          an.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
          const rms = Math.sqrt(sum / buf.length);
          if (rms > 0.08) over++; else over = Math.max(0, over - 1);
          if (over > 4 && useVoice.getState().state === "speaking") {
            stopSpeaking();
            useVoice.getState().setState("listening");
            return;
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch { /* mic not available; skip barge-in */ }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      try { ctx?.close(); } catch { /* noop */ }
    };
  }, [open, state]);

  const loadHistory = async () => {
    const { data } = await supabase
      .from("jarvis_interactions")
      .select("id,created_at,user_text,assistant_text,provider,model")
      .order("created_at", { ascending: false })
      .limit(30);
    if (data) setHistory(data as any);
  };
  useEffect(() => { if (open) loadHistory(); }, [open]);

  const sendTyped = () => {
    const t = typed.trim(); if (!t) return;
    setTyped("");
    hardInterrupt();
    runTurnRef.current?.(t);
  };

  const stateLabel = STATE_LABEL[state] ?? state;
  const stateColor = STATE_COLOR[state];

  const emptyHint = useMemo(() => {
    if (state === "listening") return "listening… speak naturally, or type below";
    if (state === "processing") return "thinking through it…";
    if (state === "speaking") return "responding… speak or press ⎋ to interrupt";
    if (state === "muted") return "microphone muted — click listen to resume";
    return "click LISTEN or tap the orb to speak";
  }, [state]);

  if (!open) return null;

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background:
          "radial-gradient(ellipse at 50% 42%, rgba(53,214,237,0.10), transparent 55%)," +
          "radial-gradient(ellipse at 50% 100%, rgba(53,214,237,0.06), transparent 60%)," +
          "linear-gradient(180deg, rgba(5,10,20,0.94) 0%, rgba(3,8,18,0.98) 100%)",
        backdropFilter: "blur(24px) saturate(140%)",
        display: "grid",
        gridTemplateRows: "auto 1fr auto",
        color: "var(--text)",
      }}
    >
      {/* CRT scanlines + grid */}
      <div className="scanlines" style={{ zIndex: 0 }} />
      <div className="grid-bg" style={{ zIndex: 0, opacity: 0.35 }} />
      <span className="hud-corner tl" style={{ top: 10, left: 10 }} />
      <span className="hud-corner tr" style={{ top: 10, right: 10 }} />
      <span className="hud-corner bl" style={{ bottom: 10, left: 10 }} />
      <span className="hud-corner br" style={{ bottom: 10, right: 10 }} />

      {/* HEADER */}
      <div style={{ position: "relative", zIndex: 2, display: "flex", justifyContent: "space-between", padding: "16px 26px", alignItems: "center", borderBottom: "1px solid var(--edge)" }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <span className={`live-dot ${state === "idle" ? "idle" : state === "muted" ? "err" : ""}`}
            style={{ color: stateColor as any, background: stateColor as any }} />
          <span className="hud-label" style={{ color: "var(--accent)", fontSize: 12, letterSpacing: "0.32em" }}>
            J.A.R.V.I.S
          </span>
          <span className="hud-label" style={{ color: "var(--text-dim)" }}>
            /  {brainLabel}
          </span>
          {sharing && (
            <span className="hud-label" style={{ color: "var(--danger)", display: "flex", alignItems: "center", gap: 4 }}>
              <span className="live-dot err" style={{ color: "var(--danger)", background: "var(--danger)" }} /> screen sharing
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {STATES.map((s) => (
            <span key={s}
              style={{
                padding: "4px 10px", borderRadius: 999,
                fontSize: 9, letterSpacing: "0.24em", textTransform: "uppercase",
                fontFamily: "var(--font-hud)",
                border: `1px solid ${s === state ? STATE_COLOR[s] : "var(--edge)"}`,
                color: s === state ? STATE_COLOR[s] : "var(--text-muted)",
                background: s === state ? `${STATE_COLOR[s]}14` : "transparent",
                transition: "all 200ms",
              }}>
              {STATE_LABEL[s]}
            </span>
          ))}
          <button onClick={() => setShowHistory((v) => !v)} className="focus-outline" style={pill(showHistory)} title="History">
            <History size={12} /> history
          </button>
          <button onClick={close} className="focus-outline" style={pill(false)} title="Close (Esc)">
            <X size={14} /> close
          </button>
        </div>
      </div>

      {/* BODY */}
      <div style={{ position: "relative", zIndex: 1, display: "grid", gridTemplateColumns: showHistory ? "1fr 360px" : "1fr", minHeight: 0 }}>
        <div style={{ position: "relative", display: "grid", gridTemplateRows: "1fr auto", minHeight: 0 }}>
          {/* Neural core anchor */}
          <div style={{ position: "relative", minHeight: 0, overflow: "hidden" }}>
            <JarvisCore />
            {/* Center HUD ring stat */}
            <div style={{
              position: "absolute", inset: 0, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "flex-end", padding: "0 0 40px", pointerEvents: "none",
            }}>
              <div className="hud-label" style={{ color: "var(--accent-soft)", fontSize: 10, letterSpacing: "0.4em" }}>
                {emptyHint}
              </div>
            </div>
          </div>

          {/* Transcript + streaming reply */}
          <div style={{
            padding: "18px 40px 8px",
            maxHeight: "40vh",
            overflow: "auto",
            borderTop: "1px solid var(--edge)",
            background: "linear-gradient(180deg, rgba(5,10,20,0.4), rgba(5,10,20,0.75))",
          }}>
            <AnimatePresence>
              {(transcript || interim) && (
                <motion.div key="user"
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  style={{ marginBottom: 14, fontSize: 15, lineHeight: 1.5 }}
                >
                  <span className="hud-label" style={{ color: "var(--accent)", marginRight: 8 }}>DEEPAK</span>
                  <span style={{ color: "var(--text)" }}>{transcript}</span>
                  {interim && <em style={{ color: "var(--accent-soft)", opacity: 0.55, marginLeft: 6 }}>{interim}</em>}
                </motion.div>
              )}
            </AnimatePresence>
            {(reply || state === "processing") && (
              <div style={{ fontSize: 15, lineHeight: 1.6, color: "var(--text)" }}>
                <div className="hud-label" style={{ color: "var(--ok)", marginBottom: 4 }}>JARVIS</div>
                <div style={{ fontFamily: "var(--font-body)" }}>
                  <ReactMarkdown>{reply || "…"}</ReactMarkdown>
                  {state === "processing" && (
                    <span style={{ display: "inline-block", width: 8, height: 14, background: "var(--accent)", marginLeft: 2, verticalAlign: "middle", animation: "hud-caret 900ms steps(2) infinite" }} />
                  )}
                </div>
              </div>
            )}
            {!transcript && !interim && !reply && (
              <div className="hud-label" style={{ color: "var(--text-dim)" }}>
                {emptyHint}
              </div>
            )}
          </div>
        </div>

        {/* HISTORY DRAWER */}
        {showHistory && (
          <motion.div
            initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }}
            style={{
              borderLeft: "1px solid var(--edge)",
              background: "linear-gradient(180deg, rgba(10,25,41,0.85), rgba(5,10,20,0.9))",
              overflow: "auto", padding: 16,
            }}>
            <div className="hud-label" style={{ marginBottom: 12, color: "var(--accent)", fontSize: 10 }}>
              recent conversations
            </div>
            {history.length === 0 && <div className="hud-label" style={{ color: "var(--text-dim)" }}>— empty —</div>}
            {history.map((h) => (
              <div key={h.id} style={{
                borderLeft: "2px solid var(--edge-strong)", padding: "8px 10px", marginBottom: 12, fontSize: 12,
              }}>
                <div style={{ color: "var(--accent-soft)", fontFamily: "var(--font-hud)", letterSpacing: "0.1em", fontSize: 10 }}>
                  {new Date(h.created_at).toLocaleTimeString()} · {h.model.split("/").pop()}
                </div>
                <div style={{ color: "var(--text)", marginTop: 4 }}>› {h.user_text}</div>
                <div style={{ color: "var(--text-dim)", marginTop: 3, opacity: 0.85 }}>
                  ⤺ {h.assistant_text.slice(0, 200)}{h.assistant_text.length > 200 ? "…" : ""}
                </div>
              </div>
            ))}
          </motion.div>
        )}
      </div>

      {/* CONTROLS + composer */}
      <div style={{
        position: "relative", zIndex: 2,
        display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center",
        padding: "14px 22px", borderTop: "1px solid var(--edge)",
        background: "linear-gradient(180deg, rgba(5,10,20,0.5), rgba(5,10,20,0.9))",
      }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={() => setState(state === "muted" ? "listening" : state === "listening" ? "muted" : "listening")}
            className="focus-outline" style={pill(state === "listening")} title="Toggle mic">
            {state === "muted" ? <MicOff size={12} /> : <Mic size={12} />}
            {state === "muted" ? "unmute" : state === "listening" ? "mute" : "listen"}
          </button>
          <button onClick={toggleContinuous} className="focus-outline" style={pill(continuous)} title="Continuous vs push-to-talk">
            {continuous ? <Play size={11} /> : <Pause size={11} />}
            {continuous ? "continuous" : "push-to-talk"}
          </button>
          <button
            onClick={() => { hardInterrupt(); useVoice.getState().setState(continuous ? "listening" : "idle"); }}
            className="focus-outline" style={pill(false)} title="Interrupt (Esc)">
            <Ban size={11} /> interrupt
          </button>
          <button
            onClick={async () => {
              try { if (sharing) stopShare(); else await startShare(); }
              catch (err: any) { push(`Screen share failed: ${err?.message ?? err}`, "err"); }
            }}
            className="focus-outline" style={pill(sharing)} title="Share screen">
            {sharing ? <MonitorOff size={11} /> : <Monitor size={11} />}
            {sharing ? "stop share" : "share screen"}
          </button>
          <BrainPicker />
          {/* Live waveform */}
          <div style={{ display: "flex", alignItems: "center", gap: 2, height: 22, marginLeft: 6 }}>
            {Array.from({ length: 18 }).map((_, i) => {
              const active = state === "listening" || state === "speaking";
              const h = Math.max(3, (active ? 0.18 + amplitude * (0.4 + Math.sin(i * 0.6 + Date.now() * 0.006) * 0.4) : 0.08) * 22);
              return <span key={i} style={{ width: 2, height: h, background: active ? "var(--accent)" : "var(--text-muted)", boxShadow: active ? "0 0 4px var(--accent)" : "none", transition: "height 80ms" }} />;
            })}
          </div>
        </div>

        {/* Text composer */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 380 }}>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendTyped(); } }}
            placeholder="Type or dictate…"
            className="focus-outline"
            style={{
              flex: 1, background: "rgba(5,10,20,0.8)", border: "1px solid var(--edge)",
              padding: "9px 12px", color: "var(--text)", fontSize: 13,
              fontFamily: "var(--font-body)", borderRadius: 2, outline: "none",
            }}
          />
          <button onClick={sendTyped} className="focus-outline" style={pill(!!typed.trim())} title="Send (Enter)">
            <Send size={12} /> send
          </button>
        </div>
      </div>

      <style>{`@keyframes hud-caret { 0%,49%{opacity:1} 50%,100%{opacity:0} }`}</style>
    </motion.div>,
    document.body,
  );
}

function pill(active: boolean): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: 5,
    padding: "6px 12px",
    border: `1px solid ${active ? "var(--edge-strong)" : "var(--edge)"}`,
    color: active ? "var(--accent)" : "var(--text-dim)",
    background: active ? "rgba(53,214,237,0.08)" : "transparent",
    fontSize: 10, fontFamily: "var(--font-hud)", letterSpacing: "0.16em",
    textTransform: "uppercase", borderRadius: 2, cursor: "pointer",
    transition: "all 180ms",
  };
}
