import { useEffect, useRef } from "react";
import { useVoice } from "@/store/voiceStore";

/**
 * Fixed, non-interactive layer that lives behind all app chrome.
 * Adds animated grid drift, radial reactor glow that pulses with voice
 * amplitude, a slow horizontal scanline sweep, and film-grain noise.
 * Zero DOM impact on interactivity; purely decorative.
 */
export default function AmbientLayer() {
  const amp = useVoice((s) => s.amplitude);
  const state = useVoice((s) => s.state);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--amp", String(Math.min(1, amp)));
  }, [amp]);

  return (
    <div ref={ref} className="ambient-layer" data-state={state} aria-hidden>
      <div className="ambient-grid" />
      <div className="ambient-reactor" />
      <div className="ambient-scan" />
      <div className="ambient-noise" />
      <div className="ambient-vignette" />
    </div>
  );
}
