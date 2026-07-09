import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import HudPanel from "@/components/hud/HudPanel";
import KineticNumber from "@/components/hud/KineticNumber";
import { Suspense, lazy } from "react";
import { useVoice } from "@/store/voiceStore";
import { db, inr, relTime, type Task, type EmailRow, type JarvisAction } from "@/lib/db";

const JarvisCore = lazy(() => import("@/components/core/JarvisCore"));

export default function Home() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(280px, 1fr) minmax(420px, 1.6fr) minmax(280px, 1fr)",
        gridTemplateRows: "1fr auto",
        gap: 12,
        padding: 12,
        height: "100%",
        minHeight: 0,
        overflow: "auto",
      }}
    >
      {/* LEFT COLUMN */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <HudPanel title="Today's Focus" index="01" live="ok" style={{ flex: 1.2 }}>
          <FocusPanelBody />
        </HudPanel>
        <HudPanel title="Daily Brief" index="02" live="ok" style={{ flex: 1 }}>
          <BriefPanelBody />
        </HudPanel>
        <HudPanel title="Alerts & Follow-ups" index="03" live="warn" style={{ flex: 1 }}>
          <AlertsPanelBody />
        </HudPanel>
      </div>

      {/* CENTER */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <CorePanel />
      </div>

      {/* RIGHT COLUMN */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <HudPanel title="Inbox Pulse" index="04" live="ok" style={{ flex: 1 }}>
          <InboxPulseBody />
        </HudPanel>
        <HudPanel title="Finance Pulse" index="05" live="ok" style={{ flex: 1.1 }}>
          <FinancePulseBody />
        </HudPanel>
        <HudPanel title="AI Tasks" index="06" live="ok" style={{ flex: 1 }}>
          <AITasksBody />
        </HudPanel>
      </div>

      {/* BOTTOM RAIL */}
      <div style={{ gridColumn: "1 / -1" }}>
        <HudPanel title="Activity Feed" index="07" live="ok">
          <ActivityBody />
        </HudPanel>
      </div>
    </div>
  );
}

function CoreFallback() {
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)" }}>
      <span className="hud-label">initialising core…</span>
    </div>
  );
}

function CorePanel() {
  const state = useVoice((s) => s.state);
  const setState = useVoice((s) => s.setState);
  const active = state === "listening" || state === "processing" || state === "speaking";

  const toggle = () => {
    if (state === "listening" || state === "speaking" || state === "processing") {
      try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
      setState("idle");
    } else {
      setState("listening");
    }
  };

  return (
    <div
      style={{ flex: 1, position: "relative", overflow: "hidden", cursor: "pointer", background: "transparent" }}
      role="button" tabIndex={0}
      aria-label={active ? "Stop talking to JARVIS" : "Talk to JARVIS"}
      onClick={toggle}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
    >
      <div style={{ position: "absolute", top: 12, left: 16, zIndex: 2, pointerEvents: "none" }}>
        <div className="h-title">
          <span className="live-dot" /><span className="h-idx">CORE</span> J.A.R.V.I.S · {active ? state.toUpperCase() : "Tap to talk"}
        </div>
      </div>
      <div style={{ position: "absolute", top: 12, right: 16, zIndex: 2, textAlign: "right", pointerEvents: "none" }}>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 22, color: "var(--accent-soft)", letterSpacing: "0.12em" }}>
          {new Date().toLocaleDateString([], { day: "2-digit" })}
          <span style={{ color: "var(--text-dim)", fontSize: 12, marginLeft: 6 }}>
            {new Date().toLocaleDateString([], { month: "short" }).toUpperCase()}
          </span>
        </div>
        <div className="hud-label" style={{ marginTop: 2 }}>
          {new Date().toLocaleDateString([], { weekday: "long" })}
        </div>
      </div>
      <Suspense fallback={<CoreFallback />}>
        <JarvisCore />
      </Suspense>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "relative", zIndex: 3 }}>
        <StatsStrip />
      </div>
    </div>
  );
}

function StatsStrip() {
  const [stats, setStats] = useState({ projects: 0, tasks: 0, unread: 0, actions: 0 });
  useEffect(() => {
    (async () => {
      try {
        const [p, t, ic, ac] = await Promise.all([
          db.projects.list(),
          db.tasks.listOpen(200),
          db.emails.counts(),
          db.actions.recent(200),
        ]);
        setStats({
          projects: p.filter((x) => x.status === "active" || x.status === "blocked").length,
          tasks: t.length,
          unread: ic.unread,
          actions: ac.length,
        });
      } catch { /* noop */ }
    })();
  }, []);
  const items = [
    { v: stats.projects, l: "projects" },
    { v: stats.tasks, l: "open tasks" },
    { v: stats.actions, l: "actions" },
    { v: stats.unread, l: "emails" },
  ];
  return (
    <div style={{
      position: "absolute", bottom: 14, left: 0, right: 0, zIndex: 2,
      display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8,
      padding: "0 20px",
    }}>
      {items.map((s, i) => (
        <motion.div
          key={s.l}
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 + i * 0.06 }}
          style={{
            padding: "10px 14px", border: "1px solid var(--edge)",
            background: "rgba(5, 10, 20, 0.6)", backdropFilter: "blur(10px)",
            textAlign: "center", position: "relative",
          }}
        >
          <span className="hud-corner tl" /><span className="hud-corner br" />
          <div style={{ fontFamily: "var(--font-display)", fontSize: 24, color: "var(--accent)", lineHeight: 1 }}>
            <KineticNumber value={s.v} />
          </div>
          <div className="hud-label" style={{ marginTop: 4 }}>{s.l}</div>
        </motion.div>
      ))}
    </div>
  );
}

function FocusPanelBody() {
  const nav = useNavigate();
  const [items, setItems] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        let list = await db.tasks.focus(7);
        if (list.length === 0) {
          // fallback: show soonest-due open tasks
          list = (await db.tasks.listOpen(7));
        }
        setItems(list);
      } finally { setLoading(false); }
    })();
  }, []);
  const toggle = async (t: Task) => {
    const next: Task["status"] = t.status === "done" ? "todo" : "done";
    await db.tasks.setStatus(t.id, next);
    setItems((cur) => cur.map((x) => x.id === t.id ? { ...x, status: next } : x));
  };
  if (loading) return <div className="hud-label" style={{ padding: 8 }}>loading…</div>;
  if (items.length === 0) return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 4 }}>
      <div className="hud-label" style={{ padding: 8, color: "var(--text-muted)" }}>no focus items yet</div>
      <button onClick={() => nav("/tasks")} className="hud-label focus-outline" style={{ border: "1px solid var(--edge)", padding: "6px 10px", color: "var(--accent)" }}>
        + add first task →
      </button>
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((t, i) => {
        const done = t.status === "done";
        return (
          <motion.button
            key={t.id}
            initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}
            onClick={() => toggle(t)}
            style={{
              display: "flex", alignItems: "center", gap: 10, textAlign: "left",
              padding: "8px 10px", border: "1px solid var(--edge)",
              background: done ? "rgba(107, 255, 176, 0.04)" : "transparent",
              fontSize: 12, color: done ? "var(--text-muted)" : "var(--text)",
              textDecoration: done ? "line-through" : "none",
              cursor: "pointer",
            }}
          >
            <span style={{
              width: 12, height: 12, flexShrink: 0,
              border: `1px solid ${done ? "var(--ok)" : "var(--edge-strong)"}`,
              background: done ? "var(--ok)" : "transparent",
            }} />
            <span style={{ flex: 1 }}>{t.title}</span>
            {t.priority === "urgent" && <span style={{ color: "var(--danger)", fontSize: 9 }}>URGENT</span>}
            {t.priority === "high" && <span style={{ color: "var(--warn)", fontSize: 9 }}>HIGH</span>}
          </motion.button>
        );
      })}
    </div>
  );
}

function BriefPanelBody() {
  // Placeholder brief (real briefing hook is runMorningBriefing in lib/briefing.ts)
  const items = [
    { t: "brief", l: "Daily briefing runs at first load" },
    { t: "voice", l: "Tap the core to talk (⎵ space)" },
    { t: "cmd", l: "Command palette: ⌘K" },
    { t: "add", l: "Capture task/note from any page" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((i, k) => (
        <div key={k} style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 12, padding: "6px 8px", borderLeft: "2px solid var(--edge-strong)" }}>
          <span style={{ fontFamily: "var(--font-display)", color: "var(--accent-soft)", fontSize: 11, minWidth: 42 }}>{i.t}</span>
          <span style={{ color: "var(--text)" }}>{i.l}</span>
        </div>
      ))}
    </div>
  );
}

function AlertsPanelBody() {
  const nav = useNavigate();
  const [state, setState] = useState<{
    overdue: number; important: number; blocked: number; dues: number;
  }>({ overdue: 0, important: 0, blocked: 0, dues: 0 });

  useEffect(() => {
    (async () => {
      try {
        const [openTasks, projects, ic, subs, cards] = await Promise.all([
          db.tasks.listOpen(200),
          db.projects.list(),
          db.emails.counts(),
          db.subscriptions.list(),
          db.cards.list(),
        ]);
        const now = Date.now();
        const soon = now + 7 * 24 * 60 * 60 * 1000;
        const overdue = openTasks.filter((t) => t.due_at && new Date(t.due_at).getTime() < now).length;
        const blocked = projects.filter((p) => p.status === "blocked").length;
        const upcomingSubs = subs.filter((s) => s.next_due_date && new Date(s.next_due_date).getTime() < soon).length;
        const upcomingCards = cards.filter((c: any) => {
          if (c.due_day == null) return false;
          const d = new Date(); d.setDate(c.due_day);
          if (d.getTime() < now) d.setMonth(d.getMonth() + 1);
          return d.getTime() < soon;
        }).length;
        setState({ overdue, important: ic.important, blocked, dues: upcomingSubs + upcomingCards });
      } catch { /* noop */ }
    })();
  }, []);

  const rows = [
    { k: state.overdue > 0 ? "err" : "idle", t: `${state.overdue} overdue task${state.overdue === 1 ? "" : "s"}`, a: "open", to: "/tasks" },
    { k: state.important > 0 ? "warn" : "idle", t: `${state.important} important email${state.important === 1 ? "" : "s"}`, a: "inbox", to: "/inbox" },
    { k: state.blocked > 0 ? "warn" : "idle", t: `${state.blocked} blocked project${state.blocked === 1 ? "" : "s"}`, a: "review", to: "/projects" },
    { k: state.dues > 0 ? "warn" : "idle", t: `${state.dues} finance due${state.dues === 1 ? "" : "s"} in 7 days`, a: "finance", to: "/finance" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((a, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", border: "1px solid var(--edge)", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span className={`live-dot ${a.k}`} />
            {a.t}
          </div>
          <button onClick={() => nav(a.to)} className="hud-label" style={{ color: "var(--accent)", padding: "3px 8px", border: "1px solid var(--edge)" }}>
            {a.a} →
          </button>
        </div>
      ))}
    </div>
  );
}

function InboxPulseBody() {
  const nav = useNavigate();
  const [counts, setCounts] = useState({ unread: 0, important: 0, needsReply: 0 });
  const [items, setItems] = useState<EmailRow[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const [c, list] = await Promise.all([db.emails.counts(), db.emails.list(undefined, 5)]);
        setCounts(c);
        setItems(list);
      } catch { /* noop */ }
    })();
  }, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
        {[{ n: counts.unread, l: "total" }, { n: counts.important, l: "important" }, { n: counts.needsReply, l: "needs reply" }].map((c) => (
          <div key={c.l} style={{ padding: "8px 6px", textAlign: "center", border: "1px solid var(--edge)" }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 18, color: "var(--accent)" }}>{c.n}</div>
            <div className="hud-label">{c.l}</div>
          </div>
        ))}
      </div>
      {items.length === 0 ? (
        <button onClick={() => nav("/inbox")} className="hud-label focus-outline" style={{ border: "1px solid var(--edge)", padding: "8px 10px", color: "var(--text-muted)" }}>
          no emails yet — connect an account →
        </button>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {items.map((i) => (
            <button key={i.id} onClick={() => nav("/inbox")} style={{ textAlign: "left", padding: "6px 8px", borderLeft: "2px solid var(--edge-strong)", fontSize: 11, background: "transparent", cursor: "pointer" }}>
              <div style={{ color: "var(--accent-soft)", fontFamily: "var(--font-hud)", letterSpacing: "0.08em" }}>{i.from_name ?? i.from_email ?? "unknown"}</div>
              <div style={{ color: "var(--text)", opacity: 0.85, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{i.subject ?? "(no subject)"}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FinancePulseBody() {
  const nav = useNavigate();
  const [state, setState] = useState<{ spend: number; income: number; cardsDue: number; subsDue: number }>({ spend: 0, income: 0, cardsDue: 0, subsDue: 0 });
  useEffect(() => {
    (async () => {
      try {
        const [m, subs] = await Promise.all([db.transactions.monthSummary(), db.subscriptions.list()]);
        const now = Date.now();
        const soon = now + 7 * 24 * 60 * 60 * 1000;
        const subsDue = subs.filter((s) => s.next_due_date && new Date(s.next_due_date).getTime() < soon).length;
        setState({ ...m, cardsDue: 0, subsDue });
      } catch { /* noop */ }
    })();
  }, []);
  const net = state.income - state.spend;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, cursor: "pointer" }} onClick={() => nav("/finance")}>
      <div style={{ padding: "10px 12px", border: "1px solid var(--edge)", background: "rgba(53, 214, 237, 0.04)" }}>
        <div className="hud-label">this month net</div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 22, color: net >= 0 ? "var(--accent-soft)" : "var(--danger)" }}>
          {inr(net)}
        </div>
        <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{inr(state.income)} in · {inr(state.spend)} out</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <div style={{ padding: 8, border: "1px solid var(--edge)" }}>
          <div className="hud-label">this month spend</div>
          <div style={{ fontFamily: "var(--font-display)", color: "var(--text)", fontSize: 15 }}>{inr(state.spend)}</div>
        </div>
        <div style={{ padding: 8, border: "1px solid var(--edge)" }}>
          <div className="hud-label">subs due (7d)</div>
          <div style={{ fontFamily: "var(--font-display)", color: state.subsDue > 0 ? "var(--warn)" : "var(--text)", fontSize: 15 }}>{state.subsDue}</div>
        </div>
      </div>
    </div>
  );
}

function AITasksBody() {
  // Phase 2+: real automations. Show automation stubs from DB when available.
  const [rows, setRows] = useState<{ l: string; p: number }[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const [reminders, actions] = await Promise.all([db.reminders.list(), db.actions.recent(50)]);
        const pending = reminders.filter((r) => !r.fired).length;
        const runToday = actions.filter((a) => new Date(a.created_at).toDateString() === new Date().toDateString()).length;
        setRows([
          { l: "Reminder queue", p: pending === 0 ? 100 : Math.min(100, pending * 20) },
          { l: "Actions today", p: Math.min(100, runToday * 12) },
          { l: "Ingestion pipeline", p: 0 },
        ]);
      } catch { /* noop */ }
    })();
  }, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.length === 0 && <div className="hud-label" style={{ padding: 8 }}>—</div>}
      {rows.map((t, i) => (
        <div key={i}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
            <span style={{ fontFamily: "var(--font-hud)", letterSpacing: "0.08em", color: "var(--text)" }}>{t.l}</span>
            <span style={{ color: "var(--accent)", fontFamily: "var(--font-display)" }}>{t.p}%</span>
          </div>
          <div style={{ height: 3, background: "rgba(53, 214, 237, 0.1)" }}>
            <motion.div
              initial={{ width: 0 }} animate={{ width: `${t.p}%` }} transition={{ duration: 0.8, delay: i * 0.1 }}
              style={{ height: "100%", background: "var(--accent)", boxShadow: "0 0 6px var(--accent)" }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function ActivityBody() {
  const [events, setEvents] = useState<JarvisAction[]>([]);
  useEffect(() => {
    (async () => {
      try { setEvents(await db.actions.recent(8)); } catch { /* noop */ }
    })();
  }, []);
  if (events.length === 0) {
    return <div className="hud-label" style={{ padding: 8, color: "var(--text-muted)" }}>no activity yet — actions log as you use JARVIS</div>;
  }
  return (
    <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
      {events.map((e) => (
        <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
          <span className={`live-dot ${e.status === "success" ? "" : e.status === "error" ? "err" : "idle"}`} />
          <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-display)", minWidth: 50 }}>{relTime(e.created_at)}</span>
          <span>{e.command_text ?? e.action_type}{e.target_module ? ` · ${e.target_module}` : ""}</span>
        </div>
      ))}
    </div>
  );
}
