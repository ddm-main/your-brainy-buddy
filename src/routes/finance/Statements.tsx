import { Fragment, useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { db, inr } from "@/lib/db";
import { useUi } from "@/store/uiStore";

// ---------- Statements ----------
function statusTone(status: string | null | undefined): "neutral" | "ok" | "warn" | "err" {
  if (status === "parsed") return "ok";
  if (status === "failed") return "err";
  if (status === "pending") return "warn";
  return "neutral";
}

export default function Statements() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [txns, setTxns] = useState<any[]>([]);
  const [txnsLoading, setTxnsLoading] = useState(false);
  const [cards, setCards] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [retryLinkId, setRetryLinkId] = useState("");
  const [retryPassword, setRetryPassword] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [loans, setLoans] = useState<any[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadType, setUploadType] = useState<"card" | "account" | "loan">("card");
  const [uploadEntityId, setUploadEntityId] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPassword, setUploadPassword] = useState("");
  const [uploading, setUploading] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterType, setFilterType] = useState<string>("");
  const [summarizingId, setSummarizingId] = useState<string | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setItems(await db.statements.list()); }
    finally { setLoading(false); }
  };

  // Statements that were never actually attempted (no linked card/account,
  // no parse_error — e.g. created before the current pipeline existed, or
  // stuck because no sync has re-run for that account since) sit at
  // 'pending' forever otherwise. One button instead of clicking retry on
  // each row individually.
  const retryAllPending = async () => {
    const targets = items.filter((s) => s.parse_status === "pending" || s.parse_status === "failed");
    if (targets.length === 0) return;
    setRetryingAll(true);
    let parsed = 0, stillStuck = 0;
    try {
      for (const s of targets) {
        try {
          const res: any = await db.statements.retry(s.id);
          if (res?.parse_status === "parsed") parsed++; else stillStuck++;
        } catch { stillStuck++; }
      }
      push(`Retried ${targets.length} · ${parsed} parsed · ${stillStuck} still unresolved`, stillStuck ? "warn" : "ok");
      await load();
    } finally { setRetryingAll(false); }
  };

  const summarize = async (s: any) => {
    setSummarizingId(s.id);
    try {
      const res: any = await db.statements.summarize(s.id);
      setItems((prev) => prev.map((x) => x.id === s.id ? { ...x, ai_summary: res.ai_summary } : x));
      push("summary ready", "ok");
    } catch (e: any) { push(e?.message ?? "summary failed", "err"); }
    finally { setSummarizingId(null); }
  };
  useEffect(() => {
    load();
    db.cards.list().then(setCards).catch(() => {});
    db.accounts.list().then(setAccounts).catch(() => {});
    db.loans.list().then(setLoans).catch(() => {});
  }, []);

  const toggleOpen = async (s: any) => {
    if (openId === s.id) { setOpenId(null); return; }
    setOpenId(s.id);
    setRetryLinkId("");
    setRetryPassword("");
    setTxnsLoading(true);
    try { setTxns(await db.statements.transactions(s.id)); }
    catch (e: any) { push(e?.message ?? "failed to load transactions", "err"); }
    finally { setTxnsLoading(false); }
  };

  const viewPdf = async (s: any) => {
    try {
      const url = await db.statements.signedPdfUrl(s.id);
      window.open(url, "_blank");
    } catch (e: any) { push(e?.message ?? "failed to open PDF", "err"); }
  };

  // For statements that never auto-resolved a card/account (so never had a
  // password to decrypt with) or that failed to parse — let the user
  // manually pick the right card/account and retry.
  const retryStatement = async (s: any) => {
    setRetrying(true);
    try {
      const linkOverride = retryLinkId
        ? cards.some((c) => c.id === retryLinkId)
          ? { credit_card_id: retryLinkId, financial_account_id: null }
          : { credit_card_id: null, financial_account_id: retryLinkId }
        : undefined;
      const res: any = await db.statements.retry(s.id, linkOverride, retryPassword || undefined);
      if (res?.parse_status === "failed") {
        push(`Retry failed: ${res?.parse_error ?? "unknown error"}`, "err");
      } else {
        push("Retry queued", "ok");
      }
      setRetryLinkId("");
      setRetryPassword("");
      await load();
      setTxns(await db.statements.transactions(s.id));
    } catch (e: any) { push(e?.message ?? "retry failed", "err"); }
    finally { setRetrying(false); }
  };

  // For banks that never email a statement — upload the PDF directly.
  const doUpload = async () => {
    if (!uploadFile) return;
    setUploading(true);
    try {
      const bytesBase64 = await fileToBase64(uploadFile);
      const res: any = await db.statements.upload({
        statement_type: uploadType,
        credit_card_id: uploadType === "card" ? uploadEntityId : null,
        financial_account_id: uploadType === "account" ? uploadEntityId : null,
        loan_id: uploadType === "loan" ? uploadEntityId : null,
        filename: uploadFile.name, bytesBase64, password: uploadPassword || undefined,
      });
      if (res?.duplicate) push("Statement already uploaded — opened existing", "ok");
      else if (res?.parse_status === "failed") push(`Uploaded, but parse failed: ${res?.parse_error ?? "unknown"}`, "err");
      else push("Statement uploaded", "ok");
      setShowUpload(false); setUploadEntityId(""); setUploadFile(null); setUploadPassword("");
      load();
    } catch (e: any) { push(e?.message ?? "upload failed", "err"); }
    finally { setUploading(false); }
  };
  const entityOptions = uploadType === "card" ? cards.map((c: any) => ({ value: c.id, label: c.card_name }))
    : uploadType === "account" ? accounts.map((a: any) => ({ value: a.id, label: a.nickname }))
    : loans.map((l: any) => ({ value: l.id, label: l.lender_name }));

  const filtered = items.filter((s) => {
    if (filterStatus && (s.parse_status ?? "manual") !== filterStatus) return false;
    if (filterType && s.statement_type !== filterType) return false;
    return true;
  });

  // Validation: sum of extracted debits should be near total_due (± 1%).
  const validationFor = (s: any, statementTxns: any[]): { ok: boolean; msg: string } | null => {
    if (s.parse_status !== "parsed" || s.total_due == null || statementTxns.length === 0) return null;
    const sumDeb = statementTxns.filter((t) => t.txn_type === "debit").reduce((a, t) => a + Number(t.amount ?? 0), 0);
    if (sumDeb === 0) return null;
    const diff = Math.abs(sumDeb - Number(s.total_due));
    const pct = diff / Number(s.total_due);
    if (pct < 0.01) return { ok: true, msg: `lines total matches due (${inr(sumDeb)})` };
    return { ok: false, msg: `lines total ${inr(sumDeb)} vs due ${inr(s.total_due)} — off by ${inr(diff)}` };
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      <HudPanel title="Statements" index="STM" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<>
          {items.some((s) => s.parse_status === "pending" || s.parse_status === "failed") && (
            <Btn size="sm" onClick={retryAllPending} disabled={retryingAll}>{retryingAll ? "retrying…" : "retry all pending"}</Btn>
          )}
          <Btn size="sm" onClick={() => setShowUpload((v) => !v)}>+ upload statement</Btn>
        </>}>
        <div style={{ display: "flex", gap: 8, alignItems: "end", marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ minWidth: 140 }}>
            <label style={labelStyle}>status</label>
            <HudSelect value={filterStatus} onChange={setFilterStatus} placeholder="all" options={[
              { value: "", label: "all" },
              { value: "parsed", label: "parsed" },
              { value: "pending", label: "pending" },
              { value: "failed", label: "failed" },
              { value: "skipped", label: "skipped" },
            ]} />
          </div>
          <div style={{ minWidth: 140 }}>
            <label style={labelStyle}>type</label>
            <HudSelect value={filterType} onChange={setFilterType} placeholder="all" options={[
              { value: "", label: "all" },
              { value: "card", label: "card" },
              { value: "account", label: "account" },
              { value: "loan", label: "loan" },
            ]} />
          </div>
          <div style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-hud)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
            {filtered.length} / {items.length}
          </div>
        </div>
        {showUpload && (
          <div style={{ padding: 10, border: "1px dashed var(--edge)", marginBottom: 10, display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
            <div>
              <label style={labelStyle}>type</label>
              <HudSelect value={uploadType} onChange={(v) => { setUploadType(v as any); setUploadEntityId(""); }} options={[
                { value: "card", label: "card" }, { value: "account", label: "account" }, { value: "loan", label: "loan" },
              ]} />
            </div>
            <div style={{ minWidth: 160 }}>
              <label style={labelStyle}>which one</label>
              <HudSelect value={uploadEntityId} onChange={setUploadEntityId} placeholder="—" options={entityOptions} />
            </div>
            <div>
              <label style={labelStyle}>PDF file</label>
              <input type="file" accept="application/pdf" onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} style={{ ...inputStyle }} />
            </div>
            <div>
              <label style={labelStyle}>password (if any)</label>
              <input type="password" value={uploadPassword} onChange={(e) => setUploadPassword(e.target.value)} style={{ ...inputStyle, width: 140 }} />
            </div>
            <Btn size="sm" variant="primary" disabled={uploading || !uploadFile || !uploadEntityId} onClick={doUpload}>{uploading ? "uploading…" : "upload"}</Btn>
          </div>
        )}
        {loading ? <div className="hud-label">loading…</div> :
         filtered.length === 0 ? <EmptyState hint="statements auto-appear when banking mail with statement subjects is synced">no statements match</EmptyState> :
         <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
           <thead>
             <tr style={{ color: "var(--text-dim)", textAlign: "left", fontSize: 10, fontFamily: "var(--font-hud)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>date</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>type</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>linked</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>period</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>txns</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>status</th>
             </tr>
           </thead>
           <tbody>
             {filtered.map((s: any) => (
               <Fragment key={s.id}>
                 <tr style={{ borderBottom: "1px solid rgba(127,233,255,0.06)", cursor: "pointer" }} onClick={() => toggleOpen(s)}>
                   <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{s.statement_date ? new Date(s.statement_date).toLocaleDateString() : "—"}</td>
                   <td style={{ padding: "6px 8px" }}><Chip>{s.statement_type}</Chip></td>
                   <td style={{ padding: "6px 8px", color: "var(--text)" }}>{s.credit_cards?.card_name ?? s.financial_accounts?.nickname ?? s.loans?.lender_name ?? "—"}</td>
                   <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{s.period_start && s.period_end ? `${s.period_start} → ${s.period_end}` : "—"}</td>
                   <td style={{ padding: "6px 8px", color: "var(--text-dim)" }}>{s.transactions_found ?? 0}</td>
                   <td style={{ padding: "6px 8px" }}><Chip tone={statusTone(s.parse_status)}>{s.parse_status ?? "manual"}</Chip></td>
                 </tr>
                 {openId === s.id && (
                   <tr>
                     <td colSpan={6} style={{ padding: "10px 8px", background: "rgba(53,214,237,0.03)", borderBottom: "1px solid rgba(127,233,255,0.06)" }}>
                       <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 11, color: "var(--text-dim)" }}>
                         <div><span className="hud-label">total due</span><br />{s.total_due != null ? inr(s.total_due) : "—"}</div>
                         <div><span className="hud-label">closing balance</span><br />{s.closing_balance != null ? inr(s.closing_balance) : "—"}</div>
                         <div><span className="hud-label">statement date</span><br />{s.statement_date ? new Date(s.statement_date).toLocaleDateString() : "—"}</div>
                         <div><span className="hud-label">due date</span><br />{s.due_date ? new Date(s.due_date).toLocaleDateString() : "—"}</div>
                         {s.file_path && <Btn size="sm" onClick={() => viewPdf(s)}>view PDF →</Btn>}
                         {s.parse_status === "parsed" && (
                           <Btn size="sm" disabled={summarizingId === s.id} onClick={() => summarize(s)}>
                             {summarizingId === s.id ? "summarizing…" : s.ai_summary ? "regenerate AI summary" : "AI summary"}
                           </Btn>
                         )}
                       </div>
                        {(() => {
                          const v = validationFor(s, txns);
                          if (!v) return null;
                          return (
                            <div style={{ marginTop: 8, padding: "4px 8px", fontSize: 11,
                                border: `1px solid ${v.ok ? "rgba(74,255,181,0.25)" : "rgba(255,190,80,0.3)"}`,
                                color: v.ok ? "var(--ok)" : "var(--warn)", borderRadius: 4 }}>
                              <Chip tone={v.ok ? "ok" : "warn"}>{v.ok ? "validated" : "mismatch"}</Chip> {v.msg}
                            </div>
                          );
                        })()}
                        {s.ai_summary && (
                          <div style={{ marginTop: 8, padding: 8, border: "1px solid var(--edge)", background: "rgba(53,214,237,0.04)", whiteSpace: "pre-wrap", fontSize: 11, color: "var(--text)" }}>
                            <div className="hud-label" style={{ marginBottom: 4 }}>AI summary</div>
                            {s.ai_summary}
                          </div>
                        )}
                        {s.parse_status === "failed" && s.parse_error && (
                          <div style={{ marginTop: 8, padding: "6px 8px", background: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.25)", borderRadius: 4, color: "var(--warn)", fontSize: 11 }}>
                            <span className="hud-label" style={{ color: "var(--warn)" }}>parse error</span> · {s.parse_error === "wrong_or_missing_password" ? "PDF is password-protected — provide the password below and retry." : s.parse_error}
                          </div>
                        )}
                        {(s.parse_status === "failed" || (!s.credit_card_id && !s.financial_account_id)) && (
                          <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "end", flexWrap: "wrap" }}>
                            <div style={{ minWidth: 200 }}>
                              <label style={labelStyle}>link to card/account</label>
                              <HudSelect value={retryLinkId} onChange={setRetryLinkId} placeholder="—" options={[
                                ...cards.map((c: any) => ({ value: c.id, label: `${c.card_name} (card)` })),
                                ...accounts.map((a: any) => ({ value: a.id, label: `${a.nickname} (account)` })),
                              ]} />
                            </div>
                            <div>
                              <label style={labelStyle}>password (optional)</label>
                              <input type="password" value={retryPassword} onChange={(e) => setRetryPassword(e.target.value)} style={{ ...inputStyle, width: 140 }} />
                            </div>
                            <Btn size="sm" variant="primary" disabled={retrying} onClick={() => retryStatement(s)}>{retrying ? "retrying…" : "retry"}</Btn>
                          </div>
                        )}
                       <div style={{ marginTop: 10 }}>
                         <span className="hud-label">transactions from this statement</span>
                         {txnsLoading ? <div className="hud-label" style={{ marginTop: 6 }}>loading…</div> :
                          txns.length === 0 ? <div className="hud-label" style={{ marginTop: 6 }}>none extracted</div> :
                          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 6 }}>
                            {txns.map((t: any) => (
                              <div key={t.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                                <span style={{ color: "var(--text)" }}>{new Date(t.txn_date).toLocaleDateString()} · {t.merchant ?? "—"}</span>
                                <span style={{ color: t.txn_type === "debit" ? "var(--warn)" : "var(--ok)" }}>{t.txn_type === "debit" ? "-" : "+"}{inr(t.amount)}</span>
                              </div>
                            ))}
                          </div>}
                       </div>
                     </td>
                   </tr>
                 )}
               </Fragment>
             ))}
           </tbody>
         </table>}
      </HudPanel>
    </div>
  );
}

function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? "");
      const idx = s.indexOf(",");
      resolve(idx >= 0 ? s.slice(idx + 1) : s);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}
