import { useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { db, inr } from "@/lib/db";
import { useUi } from "@/store/uiStore";
import { ScoreBar } from "./_shared";

/** Goal detail — progress, contribution history, and milestones for a
 * single goal. Wired at /finance/goals/:id from the Goals tab tile click. */
export default function GoalDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const push = useUi((s) => s.push);
  const [goal, setGoal] = useState<any>(null);
  const [contributions, setContributions] = useState<any[]>([]);
  const [milestones, setMilestones] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [milestoneAmount, setMilestoneAmount] = useState("");
  const [addingMilestone, setAddingMilestone] = useState(false);

  const load = async () => {
    if (!id) return;
    try {
      const [all, contribs, miles] = await Promise.all([
        db.goals.list(), db.goals.contributions.list(id), db.goals.milestones.list(id),
      ]);
      setGoal(all.find((g: any) => g.id === id) ?? null);
      setContributions(contribs);
      setMilestones(miles);
    } catch (e: any) {
      push(e?.message ?? "failed to load goal", "err");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [id]);

  const addMilestone = async () => {
    if (!id || !milestoneTitle.trim() || !milestoneAmount) return;
    setAddingMilestone(true);
    try {
      await db.goals.milestones.create(id, milestoneTitle.trim(), Number(milestoneAmount));
      setMilestoneTitle(""); setMilestoneAmount("");
      setMilestones(await db.goals.milestones.list(id));
    } catch (e: any) { push(e?.message ?? "failed to add milestone", "err"); }
    finally { setAddingMilestone(false); }
  };

  const removeMilestone = async (milestoneId: string) => {
    if (!id) return;
    await db.goals.milestones.remove(milestoneId);
    setMilestones(await db.goals.milestones.list(id));
  };

  if (loading) return <div style={{ padding: 20, color: "var(--text-dim)" }}>loading…</div>;
  if (!goal) {
    return (
      <div style={{ padding: 20 }}>
        <EmptyState hint="the goal may have been deleted">goal not found</EmptyState>
        <div style={{ marginTop: 12 }}>
          <Btn size="sm" onClick={() => nav("/finance/goals")}>← back to goals</Btn>
        </div>
      </div>
    );
  }

  const current = Number(goal.current_amount) || 0;
  const target = Number(goal.target_amount) || 0;
  const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0, overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <NavLink to="/finance/goals" style={{ fontFamily: "var(--font-hud)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--text-dim)", textDecoration: "none" }}>← goals</NavLink>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>{goal.title}</div>
        {goal.goal_type && <Chip>{goal.goal_type}</Chip>}
      </div>

      <HudPanel title="Progress" index="PRG" live={pct >= 100 ? "ok" : "warn"}>
        <div style={{ padding: 10 }}>
          <div style={{ fontSize: 32, fontFamily: "var(--font-display)" }}>{pct}%</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
            {inr(current)} of {inr(target)}{goal.target_date && ` · by ${new Date(goal.target_date).toLocaleDateString()}`}
          </div>
          <ScoreBar pct={pct} />
        </div>
      </HudPanel>

      <HudPanel title="Contribution History" index="CTB" live="ok" bodyClass="overflow-auto" style={{ flex: "0 0 auto", maxHeight: 240 }}>
        {contributions.length === 0 ? <EmptyState hint="log one from the Goals tab">no contributions yet</EmptyState> :
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: "var(--text-dim)", textAlign: "left" }}>
                <th style={{ padding: "6px 8px" }}>date</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>amount</th>
                <th style={{ padding: "6px 8px" }}>note</th>
              </tr>
            </thead>
            <tbody>
              {contributions.map((c: any) => (
                <tr key={c.id} style={{ borderTop: "1px solid var(--edge)" }}>
                  <td style={{ padding: "6px 8px" }}>{c.contributed_at}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--ok)" }}>+{inr(c.amount)}</td>
                  <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{c.note ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>}
      </HudPanel>

      <HudPanel title="Milestones" index="MIL" live="ok" bodyClass="overflow-auto" style={{ flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {milestones.length === 0 ? <EmptyState hint="add checkpoints along the way to this goal">no milestones yet</EmptyState> :
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {milestones.map((m: any) => {
                const achieved = current >= Number(m.target_amount);
                return (
                  <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 8, border: "1px solid var(--edge)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Chip tone={achieved ? "ok" : "neutral"}>{achieved ? "achieved" : "pending"}</Chip>
                      <span>{m.title}</span>
                      <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{inr(m.target_amount)}</span>
                    </div>
                    <button onClick={() => removeMilestone(m.id)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>remove</button>
                  </div>
                );
              })}
            </div>}
          <div style={{ display: "flex", gap: 6, alignItems: "end", paddingTop: 10, borderTop: "1px dashed var(--edge)" }}>
            <div><label style={labelStyle}>milestone</label><input value={milestoneTitle} onChange={(e) => setMilestoneTitle(e.target.value)} style={{ ...inputStyle, width: 160 }} /></div>
            <div><label style={labelStyle}>target amount</label><input type="number" value={milestoneAmount} onChange={(e) => setMilestoneAmount(e.target.value)} style={{ ...inputStyle, width: 120 }} /></div>
            <Btn size="sm" variant="primary" disabled={addingMilestone || !milestoneTitle.trim() || !milestoneAmount} onClick={addMilestone}>{addingMilestone ? "adding…" : "+ milestone"}</Btn>
          </div>
        </div>
      </HudPanel>
    </div>
  );
}
