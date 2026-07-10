import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { MessageSquare } from "lucide-react";
import HudPanel from "@/components/hud/HudPanel";
import KineticNumber from "@/components/hud/KineticNumber";
import { Suspense, lazy } from "react";
import { useVoice } from "@/store/voiceStore";
import { useUi } from "@/store/uiStore";
import { db, inr, relTime, type Task, type EmailRow, type JarvisAction } from "@/lib/db";

const JarvisCore = lazy(() => import("@/components/core/JarvisCore"));
import VoiceBar from "@/components/hud/VoiceBar";
import JarvisConversation from "@/components/core/JarvisConversation";
import { registerNavigator } from "@/lib/jarvisTools";


const gridStagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.035, delayChildren: 0.04 } },
};
const cellIn = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

export default function Home() {
  const nav = useNavigate();
  useEffect(() => { registerNavigator((p) => nav(p)); }, [nav]);
  return (
    <motion.div className="home-grid" variants={gridStagger} initial="hidden" animate="show">
      {/* LEFT COLUMN */}
      <motion.div variants={cellIn} style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <HudPanel title="Today's Focus" index="01" live="ok" style={{ flex: 1.2 }}>
          <FocusPanelBody />
        </HudPanel>
        <HudPanel title="Alerts & Follow-ups" index="02" live="warn" style={{ flex: 1 }}>
          <AlertsPanelBody />
        </HudPanel>
        <HudPanel title="Next Up" index="03" live="ok" style={{ flex: 1 }}>
          <NextUpBody />
        </HudPanel>
      </motion.div>

      {/* CENTER */}
      <motion.div variants={cellIn} style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <CorePanel />
        <VoiceBar />
      </motion.div>

      {/* RIGHT COLUMN */}
      <motion.div variants={cellIn} style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <HudPanel title="Inbox Pulse" index="04" live="ok" style={{ flex: 1 }}>
          <InboxPulseBody />
        </HudPanel>
        <HudPanel title="Finance Pulse" index="05" live="ok" style={{ flex: 1.1 }}>
          <FinancePulseBody />
        </HudPanel>
        <HudPanel title="Reminders & Actions" index="06" live="ok" style={{ flex: 1 }}>
          <RemindersActionsBody />
        </HudPanel>
      </motion.div>

      {/* BOTTOM RAIL */}
      <motion.div variants={cellIn} style={{ gridColumn: "1 / -1" }}>
        <HudPanel title="Activity Feed" index="07" live="ok">
          <ActivityBody />
        </HudPanel>
      </motion.div>
      <JarvisConversation />
    </motion.div>
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
      <button
        onClick={(e) => { e.stopPropagation(); useUi.getState().openConversation(); }}
        onKeyDown={(e) => e.stopPropagation()}
        className="focus-outline"
        aria-label="Open conversation"
        title="Open conversation (⌘/Ctrl+J)"
        style={{
          position: "absolute", bottom: 60, right: 16, zIndex: 4,
          display: "flex", alignItems: "center", gap: 6,
          padding: "6px 12px", cursor: "pointer",
          border: "1px solid var(--edge-strong)",
          background: "var(--accent-tint)",
          color: "var(--accent)",
          fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.16em",
          textTransform: "uppercase", borderRadius: "var(--radius-hud)",
          backdropFilter: "blur(10px)",
          transition: "border-color 120ms ease, transform 60ms ease",
        }}
      >
        <MessageSquare size={11} /> converse
      </button>

      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: 56, left: 16, right: 16, zIndex: 3 }}>
        <BriefPanelBody />
      </div>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "relative", zIndex: 3 }}>
        <StatsStrip />
      </div>
    </div>
  );
}

function NextUpBody() {
  const nav = useNavigate();
  const [items, setItems] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const all = await db.tasks.listOpen(50);
        const now = Date.now();
        const soon = now + 7 * 24 * 60 * 60 * 1000;
        const upcoming = all
          .filter((t: any) => t.due_at && new Date(t.due_at).getTime() >= now && new Date(t.due_at).getTime() <= soon)
          .slice(0, 6);
        setItems(upcoming);
      } finally { setLoading(false); }
    })();
  }, []);
  if (loading) return <div className="hud-label" style={{ padding: 8 }}>loading…</div>;
  if (items.length === 0) return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 4 }}>
      <div className="hud-label" style={{ padding: 8, color: "var(--text-muted)" }}>nothing scheduled in the next 7 days</div>
      <button onClick={() => nav("/tasks")} className="hud-label focus-outline" style={{ border: "1px solid var(--edge)", padding: "6px 10px", color: "var(--accent)" }}>
        + schedule a task →
      </button>
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((t) => {
        const when = t.due_at ? new Date(t.due_at).toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short" }) : "";
        return (
          <div key={t.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", border: "1px solid var(--edge)", fontSize: 12, gap: 8 }}>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
            <span className="hud-label" style={{ color: "var(--accent-soft)" }}>{when}</span>
          </div>
        );
      })}
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
          projects: p.filter((x: any) => x.status === "active" || x.status === "blocked").length,
          tasks: t.length,
          unread: ic.unread,
          actions: ac.length,
        });
      } catch (e: any) { useUi.getState().push(`Stats failed: ${e?.message ?? "error"}`, "err"); }

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
            background: "var(--panel-tint)", backdropFilter: "blur(10px)",
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
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [brief, setBrief] = useState<{ assistant: string; at: string } | null>(null);

  const load = async () => {
    try {
      const mod = await import("@/integrations/supabase/client");
      const { data } = await (mod.supabase as any)
        .from("jarvis_interactions")
        .select("assistant_text,created_at")
        .order("created_at", { ascending: false })
        .limit(1);
      const row = (data as any)?.[0];
      setBrief(row?.assistant_text ? { assistant: row.assistant_text, at: row.created_at } : null);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const run = async () => {
    setRunning(true);
    try {
      const { jarvisChat } = await import("@/lib/jarvisChat");
      const hour = new Date().getHours();
      const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
      await jarvisChat(`${greet}, JARVIS. Give me a crisp 3-line briefing: 1) top priority today, 2) one alert I should act on, 3) one uplifting note. No fluff.`);
      await load();
    } catch (e: any) { useUi.getState().push(`Briefing failed: ${e?.message ?? "error"}`, "err"); }

    finally { setRunning(false); }
  };

  if (loading) return <div className="hud-label" style={{ padding: 8 }}>loading…</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {brief ? (
        <>
          <div style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.55, padding: 8, border: "1px solid var(--edge)", background: "rgba(53,214,237,0.03)", whiteSpace: "pre-wrap" }}>
            {brief.assistant.length > 320 ? brief.assistant.slice(0, 320) + "…" : brief.assistant}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="hud-label">{relTime(brief.at)} ago</span>
            <button onClick={run} disabled={running} className="hud-label" style={{ color: "var(--accent)", padding: "3px 8px", border: "1px solid var(--edge)", cursor: "pointer", background: "transparent" }}>
              {running ? "briefing…" : "refresh →"}
            </button>
          </div>
        </>
      ) : (
        <button onClick={run} disabled={running} className="hud-label focus-outline" style={{ border: "1px solid var(--edge)", padding: "10px 12px", color: "var(--accent)", cursor: "pointer", background: "transparent" }}>
          {running ? "· briefing in progress ·" : "+ run morning briefing"}
        </button>
      )}
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
        const overdue = openTasks.filter((t: any) => t.due_at && new Date(t.due_at).getTime() < now).length;
        const blocked = projects.filter((p: any) => p.status === "blocked").length;
        const upcomingSubs = subs.filter((s: any) => s.next_due_date && new Date(s.next_due_date).getTime() < soon).length;
        const upcomingCards = cards.filter((c: any) => {
          if (c.due_day == null) return false;
          const d = new Date(); d.setDate(c.due_day);
          if (d.getTime() < now) d.setMonth(d.getMonth() + 1);
          return d.getTime() < soon;
        }).length;
        setState({ overdue, important: ic.important, blocked, dues: upcomingSubs + upcomingCards });
      } catch (e: any) { useUi.getState().push(`Alerts failed: ${e?.message ?? "error"}`, "err"); }

    })();
  }, []);

  const rows: { k: "err" | "warn" | "idle"; n: number; label: string; a: string; to: string }[] = [
    { k: state.overdue > 0 ? "err" : "idle", n: state.overdue, label: `overdue task${state.overdue === 1 ? "" : "s"}`, a: "open", to: "/tasks" },
    { k: state.important > 0 ? "warn" : "idle", n: state.important, label: `important email${state.important === 1 ? "" : "s"}`, a: "inbox", to: "/inbox" },
    { k: state.blocked > 0 ? "warn" : "idle", n: state.blocked, label: `blocked project${state.blocked === 1 ? "" : "s"}`, a: "review", to: "/projects" },
    { k: state.dues > 0 ? "warn" : "idle", n: state.dues, label: `finance due${state.dues === 1 ? "" : "s"} in 7 days`, a: "finance", to: "/finance" },
  ];
  const allClear = rows.every((r) => r.n === 0);
  if (allClear) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: "1px solid var(--edge)", fontSize: 12 }}>
        <span className="live-dot" style={{ background: "var(--ok)", color: "var(--ok)" }} />
        <span style={{ color: "var(--text)" }}>all systems nominal</span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((a, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", border: "1px solid var(--edge)", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span className={`live-dot ${a.k}`} />
            <span style={{ fontFamily: "var(--font-display)", color: a.k === "err" ? "var(--danger)" : a.k === "warn" ? "var(--warn)" : "var(--text-dim)", minWidth: 20, display: "inline-block" }}>
              <KineticNumber value={a.n} />
            </span>
            {a.label}
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
      } catch (e: any) { useUi.getState().push(`Inbox failed: ${e?.message ?? "error"}`, "err"); }

    })();
  }, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
        {[{ n: counts.unread, l: "total" }, { n: counts.important, l: "important" }, { n: counts.needsReply, l: "needs reply" }].map((c) => (
          <div key={c.l} style={{ padding: "8px 6px", textAlign: "center", border: "1px solid var(--edge)" }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 18, color: "var(--accent)" }}><KineticNumber value={c.n} /></div>
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
        const subsDue = subs.filter((s: any) => s.next_due_date && new Date(s.next_due_date).getTime() < soon).length;
        setState({ ...m, cardsDue: 0, subsDue });
      } catch (e: any) { useUi.getState().push(`Finance failed: ${e?.message ?? "error"}`, "err"); }

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
          <div style={{ fontFamily: "var(--font-display)", color: state.subsDue > 0 ? "var(--warn)" : "var(--text)", fontSize: 15 }}>
            <KineticNumber value={state.subsDue} />
          </div>
        </div>

      </div>
    </div>
  );
}

function RemindersActionsBody() {
  const [reminders, setReminders] = useState<{ id: string; text: string; fire_at: string; fired: boolean | null }[]>([]);
  const [actions, setActions] = useState<JarvisAction[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const [rs, ac] = await Promise.all([db.reminders.list(), db.actions.recent(5)]);
        const now = Date.now();
        setReminders(
          rs
            .filter((r: any) => !r.fired && r.fire_at && new Date(r.fire_at).getTime() >= now - 60_000)
            .slice(0, 4),
        );
        setActions(ac);
      } catch (e: any) { useUi.getState().push(`Reminders failed: ${e?.message ?? "error"}`, "err"); }

      finally { setLoading(false); }
    })();
  }, []);
  if (loading) return <div className="hud-label" style={{ padding: 8 }}>loading…</div>;
  if (reminders.length === 0 && actions.length === 0) {
    return <div className="hud-label" style={{ padding: 8, color: "var(--text-muted)" }}>no reminders or actions yet</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {reminders.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div className="hud-label" style={{ color: "var(--accent-soft)" }}>upcoming</div>
          {reminders.map((r) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", border: "1px solid var(--edge)", fontSize: 11 }}>
              <span className="live-dot warn" />
              <span style={{ flex: 1, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.text}</span>
              <span className="hud-label" style={{ color: "var(--text-dim)" }}>{relTime(r.fire_at)}</span>
            </div>
          ))}
        </div>
      )}
      {actions.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div className="hud-label" style={{ color: "var(--accent-soft)" }}>recent actions</div>
          {actions.map((a) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", fontSize: 11 }}>
              <span className={`live-dot ${a.status === "success" ? "" : a.status === "error" ? "err" : "idle"}`} />
              <span style={{ flex: 1, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {a.command_text ?? a.action_type}
              </span>
              <span className="hud-label" style={{ color: "var(--text-dim)" }}>{relTime(a.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityBody() {
  const [events, setEvents] = useState<JarvisAction[]>([]);
  useEffect(() => {
    (async () => {
      try { setEvents(await db.actions.recent(8)); }
      catch (e: any) { useUi.getState().push(`Activity failed: ${e?.message ?? "error"}`, "err"); }

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
