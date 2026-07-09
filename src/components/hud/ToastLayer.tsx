import { AnimatePresence, motion } from "framer-motion";
import { useUi } from "@/store/uiStore";

export default function ToastLayer() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div style={{ position: "fixed", right: 20, bottom: 80, zIndex: 200, display: "flex", flexDirection: "column", gap: 8 }}>
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ x: 60, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 60, opacity: 0 }}
            className="hud-panel"
            style={{ padding: "10px 14px", minWidth: 240, borderColor: kindEdge(t.kind) }}
          >
            <span className="hud-corner tl" /><span className="hud-corner br" />
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <span className={`live-dot ${t.kind === "ok" ? "" : t.kind === "warn" ? "warn" : t.kind === "err" ? "err" : "idle"}`} />
              {t.message}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function kindEdge(k?: string) {
  if (k === "ok") return "rgba(107, 255, 176, 0.4)";
  if (k === "warn") return "rgba(255, 184, 77, 0.4)";
  if (k === "err") return "rgba(255, 95, 109, 0.4)";
  return "var(--edge)";
}
