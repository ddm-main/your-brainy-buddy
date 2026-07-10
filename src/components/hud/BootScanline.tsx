/**
 * One-shot 400ms scanline sweep, keyed on route path. Uses the `.boot-scan`
 * animation defined in styles.css. Extracted from `App.tsx` so any surface
 * that wants an entry sweep can drop it in.
 */
export default function BootScanline({ triggerKey }: { triggerKey: string }) {
  return <span key={triggerKey} className="boot-scan" aria-hidden />;
}
