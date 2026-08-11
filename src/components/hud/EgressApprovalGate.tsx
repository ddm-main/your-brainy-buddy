// Approval gate for reads that broke the 1 MB egress ceiling.
//
// The meter (src/lib/egressMeter.ts) remembers any Supabase response over a
// megabyte for the tab's session. The next time that same read is attempted it
// is held here until Deepak approves the transfer — with the route, the size it
// cost last time and the option to allow it for the rest of the session.
import { useEffect, useState } from "react";
import type { EgressApproval } from "@/lib/egressMeter";

export default function EgressApprovalGate() {
  const [queue, setQueue] = useState<EgressApproval[]>([]);

  useEffect(() => {
    (window as any).__egressPromptMounted = true;
    const onRequest = (ev: Event) => {
      const detail = (ev as CustomEvent<EgressApproval>).detail;
      ev.preventDefault(); // tells the meter someone is listening
      setQueue((q) => [...q, detail]);
    };
    window.addEventListener("egress:approval", onRequest as EventListener);
    return () => {
      (window as any).__egressPromptMounted = false;
      window.removeEventListener("egress:approval", onRequest as EventListener);
    };
  }, []);

  const current = queue[0];
  if (!current) return null;

  const settle = (fn: () => void) => {
    fn();
    setQueue((q) => q.slice(1));
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-destructive">
          Large transfer — approval required
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">
          This request previously returned{" "}
          <span className="font-mono font-semibold text-foreground">{current.human}</span> in a
          single response, above the 1 MB ceiling.
        </p>
        <p className="mt-2 break-all rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
          {current.route}
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          Declining cancels the read; the page will show whatever data it already has.
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => settle(current.deny)}
          >
            Decline
          </button>
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted"
            onClick={() => settle(() => current.approve(false))}
          >
            Allow once
          </button>
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
            onClick={() => settle(() => current.approve(true))}
          >
            Allow for this session
          </button>
        </div>
      </div>
    </div>
  );
}
