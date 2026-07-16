import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { Btn } from "@/components/hud/HudControls";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function PdfPage({ doc, pageNumber, scale }: { doc: any; pageNumber: number; scale: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let cancelled = false;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    if (!context) return;
    renderTaskRef.current?.cancel?.();
    setErr(null);

    doc.getPage(pageNumber)
      .then((pdfPage: any) => {
        if (cancelled) return;
        const viewport = pdfPage.getViewport({ scale });
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, viewport.width, viewport.height);
        const task = pdfPage.render({ canvasContext: context, viewport });
        renderTaskRef.current = task;
        return task.promise;
      })
      .catch((e: any) => {
        if (cancelled || e?.name === "RenderingCancelledException") return;
        setErr(e?.message ?? "render failed");
      });

    return () => { cancelled = true; renderTaskRef.current?.cancel?.(); };
  }, [doc, pageNumber, scale]);

  return (
    <div style={{ position: "relative", marginBottom: 14, textAlign: "center" }}>
      <div className="hud-label" style={{ position: "absolute", left: 4, top: 4, background: "var(--panel-tint-heavy)", padding: "2px 6px", borderRadius: 2, zIndex: 1 }}>
        page {pageNumber}
      </div>
      {err && <div style={{ padding: 8, color: "var(--warn)", fontSize: 12 }}>{err}</div>}
      <canvas
        ref={canvasRef}
        style={{ display: err ? "none" : "inline-block", maxWidth: "100%", height: "auto", background: "#f8fafc", boxShadow: "0 0 0 1px var(--edge)" }}
      />
    </div>
  );
}

export function PdfCanvasViewer({
  url,
  title,
  password,
  initialScale = 1.15,
}: {
  url: string;
  title: string;
  password?: string | null;
  initialScale?: number;
}) {
  const [doc, setDoc] = useState<any>(null);
  const [pages, setPages] = useState(0);
  const [scale, setScale] = useState(initialScale);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setScale(initialScale); }, [initialScale, url]);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setPages(0);
    setError(null);
    setStatus("loading");
    let task: any = null;

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`PDF download failed (${res.status})`);
        return res.arrayBuffer();
      })
      .then((buffer) => {
        if (cancelled) return null;
        task = pdfjsLib.getDocument({
          data: new Uint8Array(buffer),
          password: password || undefined,
          isEvalSupported: false,
        });
        return task.promise;
      })
      .then((loaded) => {
        if (!loaded) return;
        if (cancelled) { loaded.destroy().catch(() => {}); return; }
        setDoc(loaded);
        setPages(loaded.numPages);
        setStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setStatus("error");
        const msg = e?.message ?? "PDF could not be rendered in the app";
        setError(/password/i.test(msg) ? "PDF password is required or incorrect for this file." : msg);
      });

    return () => { cancelled = true; task?.destroy?.(); };
  }, [url, password]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--edge)", background: "var(--panel-tint)" }}>
        <div className="hud-label" style={{ minWidth: 90 }}>{pages ? `${pages} page${pages === 1 ? "" : "s"}` : "—"}</div>
        <div style={{ flex: 1 }} />
        <Btn size="sm" disabled={!doc || scale <= 0.75} onClick={() => setScale((v) => Math.max(0.75, Number((v - 0.15).toFixed(2))))}>−</Btn>
        <div className="hud-label" style={{ minWidth: 48, textAlign: "center" }}>{Math.round(scale * 100)}%</div>
        <Btn size="sm" disabled={!doc || scale >= 2.25} onClick={() => setScale((v) => Math.min(2.25, Number((v + 0.15).toFixed(2))))}>+</Btn>
      </div>
      <div style={{ position: "relative", flex: 1, minHeight: 0, overflow: "auto", background: "var(--bg-void)", padding: 18 }}>
        {status === "loading" && (
          <div className="hud-label" style={{ position: "absolute", left: 18, top: 18 }}>loading PDF…</div>
        )}
        {error && <div style={{ padding: 18, color: "var(--warn)", fontSize: 12 }}>{error}</div>}
        {doc && !error && (
          <div aria-label={title}>
            {Array.from({ length: pages }, (_, i) => (
              <PdfPage key={i + 1} doc={doc} pageNumber={i + 1} scale={scale} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default PdfCanvasViewer;