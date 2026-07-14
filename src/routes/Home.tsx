import { useEffect, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import HudPanel from "@/components/hud/HudPanel";
import KineticNumber from "@/components/hud/KineticNumber";
import { useUi } from "@/store/uiStore";
import { useVoice } from "@/store/voiceStore";
import { db, inr, relTime, type Task } from "@/lib/db";
import { useFinanceSnapshot } from "@/lib/useFinanceSnapshot";

import VoiceBar from "@/components/hud/VoiceBar";
import JarvisCore from "@/components/core/JarvisCore";
import JarvisConversation from "@/components/core/JarvisConversation";
import { registerNavigator } from "@/lib/jarvisTools";

const gridStagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.05 } },
};
const cellIn = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

export default function Home() {
  const nav = useNavigate();
  useEffect(() => { registerNavigator((p) => nav(p)); }, [nav]);

  return (
    <motion.div className="home-grid" variants={gridStagger} initial="hidden" animate="show">
      <motion.div variants={cellIn} className="home-cell home-col-left home-row-1">
        <HudPanel title="Mission Control" index="01" live="ok">
          <MissionControlBody />
        </HudPanel>
      </motion.div>

      <motion.div variants={cellIn} className="home-cell home-col-left home-row-2">
        <HudPanel title="Daily Brief" index="02" live="ok">
          <BriefWithStatsBody />
        </HudPanel>
      </motion.div>

      <motion.div variants={cellIn} className="home-core-wrap">
        <CorePanel />
      </motion.div>

      <motion.div variants={cellIn} className="home-cell home-col-right home-row-1">
        <HudPanel title="Signal" index="03" live="warn">
          <SignalBody />
        </HudPanel>
      </motion.div>

      <motion.div variants={cellIn} className="home-cell home-col-right home-row-2">
        <HudPanel title="Pulse" index="04" live="ok">
          <PulseBody />
        </HudPanel>
      </motion.div>

      <div className="home-deck">
        <VoiceBar />
      </div>

      <JarvisConversation />
    </motion.div>
  );
}

/* ---------- Center: JARVIS Core (transparent, no panel) ---------- */
function CorePanel() {
  const openConversation = useUi((s) => s.openConversation);
  const voiceState = useVoice((s) => s.state);
  const setVoiceState = useVoice((s) => s.setState);

  const toggleListen = () => {
    setVoiceState(voiceState === "listening" ? "idle" : "listening");
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleListen(); }
  };

  return (
    <div className="home-core">
      <div
        className="home-core-stage"
        role="button"
        tabIndex={0}
        aria-label="Toggle listening"
        onClick={toggleListen}
        onKeyDown={onKey}
      >
        <JarvisCore />
      </div>
      <div className="home-core-tl h-title">
        <span className="live-dot" />
        <span className="h-idx">CORE</span>
        <span>J.A.R.V.I.S · Tap to talk</span>
      </div>
      <div className="home-core-tr">
        <DateChip />
      </div>
      <button
        type="button"
        className="home-core-br focus-outline"
        onClick={openConversation}
        aria-label="Open conversation"
      >
        converse →
      </button>
    </div>
  );
}

/* ---------- Header chip ---------- */
function DateChip() {
  const d = new Date();
  return (
    <div className="date-chip">
      <span className="date-chip-day">{d.toLocaleDateString([], { day: "2-digit" })}</span>
      <span className="date-chip-mon">{d.toLocaleDateString([], { month: "short" }).toUpperCase()}</span>
      <span className="date-chip-wk">{d.toLocaleDateString([], { weekday: "short" }).toUpperCase()}</span>
    </div>
  );
}

/* ---------- 01 Mission Control (Focus + Next 7 days + Finance) ---------- */
interface DueSoonRow { label: string; date: string }

function MissionControlBody() {
  const nav = useNavigate();
  const [focus, setFocus] = useState<Task[]>([]);
  const [next7, setNext7] = useState<Task[]>([]);
  const [billsSoon, setBillsSoon] = useState<DueSoonRow[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [goalsSoon, setGoalsSoon] = useState<any[]>([]);
  const [alertCount, setAlertCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        let f = await db.tasks.focus(6);
        const open = await db.tasks.listOpen(80);
        if (f.length === 0) f = open.slice(0, 6);
        const now = Date.now();
        const soon = now + 7 * 24 * 60 * 60 * 1000;
        const focusIds = new Set(f.map((x: Task) => x.id));
        const upcoming = open
          .filter((t: Task) => !!t.due_at && new Date(t.due_at as string).getTime() >= now && new Date(t.due_at as string).getTime() <= soon)
          .filter((t: Task) => !focusIds.has(t.id))
          .slice(0, 4);
        setFocus(f);
        setNext7(upcoming);

        const [loans, dues, goals, openAlerts] = await Promise.all([
          db.loans.list(), db.statements.upcomingDues(6), db.goals.list(), db.alerts.list({ status: "open" }),
        ]);
        const inWindow = (iso: string | null | undefined) => {
          if (!iso) return false;
          const t = new Date(iso).getTime();
          return t >= now && t <= soon;
        };
        const loanRows: DueSoonRow[] = loans
          .filter((l: any) => inWindow(l.next_due_date))
          .map((l: any) => ({ label: `EMI · ${l.lender_name} · ${inr(l.emi_amount ?? 0)}`, date: l.next_due_date }));
        const stmtRows: DueSoonRow[] = dues
          .filter((s: any) => inWindow(s.due_date))
          .map((s: any) => ({
            label: `${s.credit_cards?.card_name ?? s.financial_accounts?.nickname ?? "—"} · due ${new Date(s.due_date).toLocaleDateString([], { day: "2-digit", month: "short" })}`,
            date: s.due_date,
          }));
        setBillsSoon([...loanRows, ...stmtRows].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4));

        const in30 = now + 30 * 24 * 60 * 60 * 1000;
        setGoalsSoon(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          goals.filter((g: any) => g.target_date && new Date(g.target_date).getTime() >= now && new Date(g.target_date).getTime() <= in30).slice(0, 3),
        );
        setAlertCount(openAlerts.length);
      } finally { setLoading(false); }
    })();
  }, []);

  const toggle = async (t: Task) => {
    const next: Task["status"] = t.status === "done" ? "todo" : "done";
    await db.tasks.setStatus(t.id, next);
    setFocus((cur) => cur.map((x) => x.id === t.id ? { ...x, status: next } : x));
  };

  if (loading) return <div className="hud-label" style={{ padding: 8 }}>loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
      <div>
        <div className="section-label">TODAY'S FOCUS</div>
        {focus.length === 0 ? (
          <div className="hud-label empty-line">no focus items yet</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
            {focus.map((t, i) => {
              const done = t.status === "done";
              return (
                <motion.button
                  key={t.id}
                  initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.03 }}
                  onClick={() => toggle(t)}
                  className="focus-row"
                  data-done={done ? "1" : "0"}
                  data-prio={t.priority ?? "normal"}
                >
                  <span className="focus-check" data-done={done ? "1" : "0"} />
                  <span className="focus-title">{t.title}</span>
                  {t.priority === "urgent" && <span className="prio-tag err">URGENT</span>}
                  {t.priority === "high" && <span className="prio-tag warn">HIGH</span>}
                </motion.button>
              );
            })}
          </div>
        )}
      </div>

      {next7.length > 0 && (
        <div>
          <div className="section-label">NEXT 7 DAYS</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
            {next7.map((t) => {
              const when = t.due_at ? new Date(t.due_at).toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short" }) : "";
              return (
                <div key={t.id} className="next-row">
                  <span className="next-title">{t.title}</span>
                  <span className="hud-label" style={{ color: "var(--accent-soft)" }}>{when}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {billsSoon.length > 0 && (
        <div>
          <div className="section-label">BILLS &amp; EMIS DUE SOON</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
            {billsSoon.map((b, i) => (
              <div key={i} className="next-row">
                <span className="next-title">{b.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {goalsSoon.length > 0 && (
        <div>
          <div className="section-label">GOALS NEEDING ATTENTION</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
            {goalsSoon.map((g) => (
              <div key={g.id} className="next-row">
                <span className="next-title">{g.title}</span>
                <span className="hud-label" style={{ color: "var(--warn)" }}>by {new Date(g.target_date).toLocaleDateString([], { day: "2-digit", month: "short" })}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {alertCount > 0 && (
        <div className="next-row" style={{ cursor: "pointer" }} onClick={() => nav("/finance")}>
          <span className="next-title" style={{ color: "var(--warn)" }}>{alertCount} finance alert{alertCount === 1 ? "" : "s"} need attention</span>
          <span className="hud-label" style={{ color: "var(--accent-soft)" }}>review →</span>
        </div>
      )}

      <div style={{ marginTop: "auto" }}>
        <button onClick={() => nav("/tasks")} className="hud-inline-cta focus-outline">
          + add task →
        </button>
      </div>
    </div>
  );
}

/* ---------- 02 Daily Brief + stats ---------- */
function BriefWithStatsBody() {
  const [brief, setBrief] = useState<{ assistant: string; at: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState({ projects: 0, tasks: 0, unread: 0, actions: 0 });

  const loadBrief = async () => {
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

  useEffect(() => {
    loadBrief();
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

  const run = async () => {
    setRunning(true);
    try {
      const { jarvisChat } = await import("@/lib/jarvisChat");
      const hour = new Date().getHours();
      const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
      await jarvisChat(`${greet}, JARVIS. Give me a crisp 3-line briefing: 1) top priority today, 2) one alert I should act on, 3) one uplifting note. No fluff.`);
      await loadBrief();
    } catch (e: any) { useUi.getState().push(`Briefing failed: ${e?.message ?? "error"}`, "err"); }
    finally { setRunning(false); }
  };

  const tiles = [
    { v: stats.projects, l: "projects" },
    { v: stats.tasks, l: "open tasks" },
    { v: stats.unread, l: "emails" },
    { v: stats.actions, l: "actions" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
      {loading ? (
        <div className="hud-label" style={{ padding: 8 }}>loading brief…</div>
      ) : brief ? (
        <div className="brief-text">
          {brief.assistant.length > 380 ? brief.assistant.slice(0, 380) + "…" : brief.assistant}
        </div>
      ) : (
        <div className="brief-empty">no briefing yet — run one to sync with JARVIS</div>
      )}

      <div className="brief-tiles">
        {tiles.map((s) => (
          <div key={s.l} className="brief-tile">
            <span className="hud-corner tl" /><span className="hud-corner br" />
            <div className="brief-tile-num"><KineticNumber value={s.v} /></div>
            <div className="hud-label" style={{ marginTop: 4 }}>{s.l}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: "auto", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span className="hud-label">
          {brief ? `updated ${relTime(brief.at)} ago` : "· awaiting sync ·"}
        </span>
        <button onClick={run} disabled={running} className="hud-inline-cta focus-outline">
          {running ? "briefing…" : brief ? "refresh →" : "+ run morning briefing"}
        </button>
      </div>
    </div>
  );
}

/* ---------- 03 Signal (alerts + reminders) ---------- */
function SignalBody() {
  const nav = useNavigate();
  const [state, setState] = useState<{ overdue: number; blocked: number; dues: number }>({
    overdue: 0, blocked: 0, dues: 0,
  });
  const [reminders, setReminders] = useState<{ id: string; text: string; fire_at: string }[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [openTasks, projects, subs, cards, rs] = await Promise.all([
          db.tasks.listOpen(200),
          db.projects.list(),
          db.subscriptions.list(),
          db.cards.list(),
          db.reminders.list(),
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
        setState({ overdue, blocked, dues: upcomingSubs + upcomingCards });
        setReminders(
          rs.filter((r: any) => !r.fired && r.fire_at && new Date(r.fire_at).getTime() >= now - 60_000).slice(0, 2),
        );
      } catch (e: any) { useUi.getState().push(`Signal failed: ${e?.message ?? "error"}`, "err"); }
    })();
  }, []);

  const rows: { sev: "err" | "warn" | "ok"; n: number; label: string; a: string; to: string }[] = [
    { sev: state.overdue > 0 ? "err" : "ok", n: state.overdue, label: `overdue task${state.overdue === 1 ? "" : "s"}`, a: "open", to: "/tasks" },
    { sev: state.blocked > 0 ? "warn" : "ok", n: state.blocked, label: `blocked project${state.blocked === 1 ? "" : "s"}`, a: "review", to: "/projects" },
    { sev: state.dues > 0 ? "warn" : "ok", n: state.dues, label: `finance due${state.dues === 1 ? "" : "s"} in 7d`, a: "finance", to: "/finance" },
  ];
  const allClear = rows.every((r) => r.n === 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
      {allClear ? (
        <div className="signal-nominal">
          <span className="live-dot" />
          <span>all systems nominal</span>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.filter((r) => r.n > 0).map((r, i) => (
            <div key={i} className="signal-row" data-sev={r.sev}>
              <span className={`live-dot ${r.sev === "err" ? "err" : r.sev === "warn" ? "warn" : ""}`} />
              <span className="signal-num"><KineticNumber value={r.n} /></span>
              <span className="signal-label">{r.label}</span>
              <button onClick={() => nav(r.to)} className="hud-label signal-cta">{r.a} →</button>
            </div>
          ))}
        </div>
      )}

      {reminders.length > 0 && (
        <div>
          <div className="section-label">REMINDERS</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
            {reminders.map((r) => (
              <div key={r.id} className="reminder-row">
                <span className="live-dot warn" />
                <span className="reminder-text">{r.text}</span>
                <span className="hud-label" style={{ color: "var(--text-dim)" }}>{relTime(r.fire_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- 04 Pulse (Finance) ---------- */
function PulseBody() {
  const nav = useNavigate();
  const { state, netWorth, utilization, health, upcomingBills, insights } = useFinanceSnapshot();
  const net = state.income - state.spend;
  const nextBill = upcomingBills[0];
  const topInsight = insights[0];

  return (
    <div className="pulse-grid">
      <button className="pulse-cluster" onClick={() => nav("/finance")} aria-label="Open finance">
        <div className="section-label">FINANCE</div>
        <div className="pulse-net" data-neg={netWorth.netWorth < 0 ? "1" : "0"}>
          <div className="hud-label">net worth</div>
          <div className="pulse-net-val">{inr(netWorth.netWorth)}</div>
          <div className="pulse-net-sub">{inr(state.income)} in · {inr(state.spend)} out this month</div>
        </div>
        <div className="pulse-mini-grid">
          <div className="pulse-mini">
            <div className="hud-label">this month net</div>
            <div className="pulse-mini-val" style={{ color: net >= 0 ? "var(--ok)" : "var(--danger)" }}>{inr(net)}</div>
          </div>
          <div className="pulse-mini">
            <div className="hud-label">utilization</div>
            <div className="pulse-mini-val">{utilization.aggregatePct == null ? "—" : `${utilization.aggregatePct}%`}</div>
          </div>
          <div className="pulse-mini">
            <div className="hud-label">health</div>
            <div className="pulse-mini-val" style={{ color: health.score >= 70 ? "var(--ok)" : health.score >= 40 ? "var(--warn)" : "var(--danger)" }}>
              {health.score}<span style={{ fontSize: 10, color: "var(--text-dim)" }}>/100</span>
            </div>
          </div>
        </div>
        {nextBill && (
          <div className="pulse-net-sub" style={{ marginTop: 8 }}>
            next bill · {nextBill.label} · {new Date(nextBill.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}{nextBill.amount != null ? ` · ${inr(nextBill.amount)}` : ""}
          </div>
        )}
        {topInsight && (
          <div className="pulse-net-sub" style={{ marginTop: 4, color: topInsight.severity === "danger" ? "var(--danger)" : topInsight.severity === "warn" ? "var(--warn)" : "var(--text-dim)" }}>
            ▲ {topInsight.text}
          </div>
        )}
      </button>
    </div>
  );
}
