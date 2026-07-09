import { useContent, type ContentCard } from "@/store/contentStore";
import { motion, AnimatePresence } from "framer-motion";
import { X, Newspaper, Cloud, Plane, Brain, BellRing, Camera, FileText, AlertTriangle, Search } from "lucide-react";

export default function ContentPanel() {
  const cards = useContent((s) => s.cards);
  const clear = useContent((s) => s.clear);
  if (!cards.length) return null;

  return (
    <div
      style={{
        position: "fixed",
        right: 12,
        bottom: 78,
        width: 360,
        maxHeight: "70vh",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 20,
        pointerEvents: "auto",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 4px" }}>
        <span className="hud-label" style={{ color: "var(--accent)" }}>● live feed · {cards.length}</span>
        <button
          onClick={clear}
          className="hud-label"
          style={{ color: "var(--text-dim)", padding: "2px 6px", border: "1px solid var(--edge)", background: "transparent" }}
          title="Clear"
        >
          <X size={11} />
        </button>
      </div>
      <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, paddingRight: 4 }}>
        <AnimatePresence initial={false}>
          {cards.map((c) => (
            <motion.div
              key={c.id}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 40 }}
              transition={{ duration: 0.25 }}
            >
              <Card card={c} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Card({ card }: { card: ContentCard }) {
  return (
    <div
      style={{
        position: "relative",
        border: "1px solid var(--edge)",
        background: "rgba(5, 10, 20, 0.85)",
        backdropFilter: "blur(14px)",
        padding: 10,
        fontSize: 12,
        color: "var(--text)",
      }}
    >
      <Header card={card} />
      <Body card={card} />
    </div>
  );
}

function Header({ card }: { card: ContentCard }) {
  const Icon =
    card.type === "news" ? Newspaper :
    card.type === "search" ? Search :
    card.type === "weather" ? Cloud :
    card.type === "flight" ? Plane :
    card.type === "memory" ? Brain :
    card.type === "reminder" ? BellRing :
    card.type === "vision" ? Camera :
    card.type === "file" ? FileText :
    AlertTriangle;

  const title =
    "title" in card ? card.title :
    card.type === "memory" ? `Remembered · ${card.topic}` :
    card.type === "reminder" ? "Reminder scheduled" :
    card.type === "vision" ? `Looking at ${card.kind}` :
    card.type === "file" ? `File · ${card.filename}` :
    "Error";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
      <Icon size={12} color="var(--accent)" />
      <span className="hud-label" style={{ color: "var(--accent-soft)" }}>{title}</span>
    </div>
  );
}

function Body({ card }: { card: ContentCard }) {
  if (card.type === "news" || card.type === "search") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {card.results.slice(0, 4).map((r, i) => (
          <a
            key={i}
            href={r.url}
            target="_blank"
            rel="noreferrer noopener"
            style={{ display: "block", padding: "4px 0", borderTop: i ? "1px dashed var(--edge)" : "none", color: "var(--text)", textDecoration: "none" }}
          >
            <div style={{ color: "var(--accent-soft)", fontSize: 11 }}>{r.source}</div>
            <div style={{ fontSize: 12 }}>{r.title}</div>
            <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{r.snippet}</div>
          </a>
        ))}
      </div>
    );
  }
  if (card.type === "weather") {
    const t = card.current?.temperature_2m;
    const hum = card.current?.relative_humidity_2m;
    const wind = card.current?.wind_speed_10m;
    return (
      <div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontFamily: "var(--font-display)", fontSize: 28, color: "var(--accent)" }}>
            {t != null ? Math.round(t) : "--"}°
          </span>
          <span className="hud-label">{hum != null ? `${hum}% RH` : ""} {wind != null ? `· ${wind} m/s` : ""}</span>
        </div>
        <div style={{ display: "flex", gap: 2, marginTop: 6, height: 24 }}>
          {(card.hourly.temperature ?? []).slice(0, 24).map((v: number, i: number) => {
            const max = Math.max(...(card.hourly.temperature ?? [1]));
            const min = Math.min(...(card.hourly.temperature ?? [0]));
            const range = Math.max(1, max - min);
            const h = ((v - min) / range) * 22 + 2;
            return <span key={i} style={{ width: 4, background: "var(--accent)", height: h, opacity: 0.5 + i / 48 }} />;
          })}
        </div>
      </div>
    );
  }
  if (card.type === "flight") {
    return (
      <div>
        <div style={{ color: "var(--text-muted)", fontSize: 10, marginBottom: 4 }}>{card.note}</div>
        {card.results?.slice(0, 3).map((r, i) => (
          <a key={i} href={r.url} target="_blank" rel="noreferrer noopener" style={{ display: "block", fontSize: 11, color: "var(--text)", textDecoration: "none", marginTop: 4 }}>
            <span style={{ color: "var(--accent-soft)" }}>{r.source} · </span>{r.title}
          </a>
        ))}
      </div>
    );
  }
  if (card.type === "memory") {
    return <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{card.action}</div>;
  }
  if (card.type === "reminder") {
    return (
      <div style={{ fontSize: 11 }}>
        <div>{card.text}</div>
        <div style={{ color: "var(--text-muted)", fontSize: 10 }}>at {new Date(card.fireAt).toLocaleString()}</div>
      </div>
    );
  }
  if (card.type === "vision") {
    return (
      <div style={{ display: "flex", gap: 8 }}>
        {card.thumbUrl ? (
          <img src={card.thumbUrl} alt="" style={{ width: 80, height: 60, objectFit: "cover", border: "1px solid var(--edge)" }} />
        ) : (
          <div style={{ width: 80, height: 60, border: "1px dashed var(--edge)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "var(--text-muted)" }}>…</div>
        )}
        <div style={{ fontSize: 11, flex: 1 }}>{card.description ?? "…"}</div>
      </div>
    );
  }
  if (card.type === "file") {
    return <div style={{ fontSize: 11 }}>{card.summary}</div>;
  }
  if (card.type === "error") {
    return <div style={{ fontSize: 11, color: "var(--danger)" }}>{card.message}</div>;
  }
  return null;
}