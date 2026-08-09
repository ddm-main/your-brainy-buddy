/**
 * Fixed, non-interactive layer that lives behind all app chrome.
 * Purely decorative: grid drift, radial glow, scanline sweep, film grain.
 */
export default function AmbientLayer() {
  return (
    <div className="ambient-layer" data-state="idle" aria-hidden>
      <div className="ambient-grid" />
      <div className="ambient-reactor" />
      <div className="ambient-scan" />
      <div className="ambient-noise" />
      <div className="ambient-vignette" />
    </div>
  );
}
