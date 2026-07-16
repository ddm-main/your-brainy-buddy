import { useEffect, useState } from "react";
import { Btn, Chip, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { PdfCanvasViewer } from "@/components/finance/PdfCanvasViewer";
import { db } from "@/lib/db";
import { useUi } from "@/store/uiStore";

// Fields a user can correct from the review panel, grouped by input type.
const DATE_FIELDS = ["statement_date", "due_date", "period_start", "period_end"] as const;
const AMOUNT_FIELDS = ["total_due", "min_due", "closing_balance", "credit_limit"] as const;
const TEXT_FIELDS = ["card_last4"] as const;

type FieldKey = typeof DATE_FIELDS[number] | typeof AMOUNT_FIELDS[number] | typeof TEXT_FIELDS[number];

const LABELS: Record<FieldKey, string> = {
  statement_date: "Statement date",
  due_date: "Payment due date",
  period_start: "Period start",
  period_end: "Period end",
  total_due: "Total due (₹)",
  min_due: "Minimum due (₹)",
  closing_balance: "Closing balance (₹)",
  credit_limit: "Credit limit (₹)",
  card_last4: "Card last digits (e.g. 62, XX62, or 6662)",
};

function statementValue(s: any, key: FieldKey): any {
  if (key === "card_last4") {
    return s?.card_last4
      ?? s?.manual_fields?.card_last4
      ?? s?.credit_cards?.masked_number
      ?? null;
  }
  return s?.[key] ?? s?.manual_fields?.[key] ?? null;
}

/** Compute the full set of missing / relevant fields for a statement row. */
export function missingFieldsFor(s: any): FieldKey[] {
  const isCard = s?.statement_type === "card";
  const isAccount = s?.statement_type === "account";
  const list: FieldKey[] = [];
  if (statementValue(s, "statement_date") == null) list.push("statement_date");
  if (isCard) {
    if (statementValue(s, "due_date") == null) list.push("due_date");
    if (statementValue(s, "total_due") == null) list.push("total_due");
    if (statementValue(s, "min_due") == null) list.push("min_due");
    if (statementValue(s, "credit_limit") == null) list.push("credit_limit");
    if (statementValue(s, "card_last4") == null) list.push("card_last4");
  }
  if (isAccount) {
    if (statementValue(s, "closing_balance") == null) list.push("closing_balance");
  }
  if (statementValue(s, "period_start") == null) list.push("period_start");
  if (statementValue(s, "period_end") == null) list.push("period_end");
  return list;
}

export function StatementReviewPanel({
  statement,
  onSaved,
}: {
  statement: any;
  onSaved: (updated: Partial<Record<FieldKey, any>>, result?: any) => void | Promise<void>;
}) {
  const push = useUi((s) => s.push);
  const [pdf, setPdf] = useState<{ url: string; password: string | null } | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(true);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const missing = missingFieldsFor(statement);

  useEffect(() => {
    // Prefill inputs with any value already present so the user only fills
    // the actual blanks; but if the row has a value we typically won't render
    // the field. Keep the state general so later edits still work.
    const seed: Record<string, string> = {};
    for (const k of [...DATE_FIELDS, ...AMOUNT_FIELDS, ...TEXT_FIELDS] as string[]) {
      const v = statementValue(statement, k as FieldKey);
      if (v != null) seed[k] = String(v).slice(0, 10);
    }
    setValues(seed);
  }, [statement?.id]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setPdfLoading(true);
    setPdfError(null);
    setPdf(null);
    if (!statement?.file_path) {
      setPdfError("no PDF attached — attach one to review");
      setPdfLoading(false);
      return () => { cancelled = true; };
    }
    db.statements.signedPdfUrl(statement.id)
      .then(async (r) => {
        // Fetch → blob URL so the PDF is served from our own origin.
        // Some browsers (Edge SmartScreen, strict tracking prevention) block
        // third-party storage URLs inside iframes with a generic "page blocked"
        // page; a blob: URL sidesteps that entirely.
        try {
          const resp = await fetch(r.url);
          if (!resp.ok) throw new Error(`fetch ${resp.status}`);
          const blob = await resp.blob();
          objectUrl = URL.createObjectURL(blob);
          if (!cancelled) { setPdf({ url: objectUrl, password: r.password }); setPdfLoading(false); }
        } catch {
          // Fall back to the direct signed URL — better than nothing.
          if (!cancelled) { setPdf({ url: r.url, password: r.password }); setPdfLoading(false); }
        }
      })
      .catch((e: any) => { if (!cancelled) { setPdfError(e?.message ?? "could not open PDF"); setPdfLoading(false); } });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [statement?.id, statement?.file_path]);

  const [lastLearned, setLastLearned] = useState<{ fields: string[]; siblings: number } | null>(null);

  const save = async () => {
    setSaving(true);
    try {
      const payload: Record<string, any> = {};
      for (const k of missing) {
        const raw = values[k];
        if (raw == null || raw === "") continue;
        payload[k] = raw;
      }
      if (Object.keys(payload).length === 0) {
        push("Fill in at least one field first", "warn");
        return;
      }
      const suppliedLast4 = typeof payload.card_last4 === "string" ? payload.card_last4 : null;
      const result: any = await db.statements.saveManualFields(statement.id, payload);
      const learned: string[] = result?.learned_fields ?? [];
      const siblings: number = result?.siblings_auto_parsed ?? 0;
      setLastLearned({ fields: learned, siblings });
      const msgParts = [`Saved ${Object.keys(payload).length} field(s)`];
      if (learned.length) msgParts.push(`learned ${learned.length} anchor(s)`);
      if (siblings) msgParts.push(`auto-parsed ${siblings} sibling(s)`);
      push(msgParts.join(" · "), "ok");

      // If the user supplied card_last4 AND the statement wasn't linked to a
      // card yet, the manual-fields handler will have suffix-matched and
      // linked it. Kick off a retry so the parser can run against the newly
      // linked card and clear the "needs retry" state in one action instead
      // of two.
      if (suppliedLast4 && !statement.credit_card_id && result?.linked_card_id) {
        try { await db.statements.retry(statement.id); } catch { /* surfaced by onSaved refresh */ }
      }

      await onSaved(payload, result);
    } catch (e: any) {
      push(e?.message ?? "save failed", "err");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: 8, border: "1px solid var(--edge)", borderRadius: 4, background: "rgba(53,214,237,0.03)", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--edge)", display: "flex", alignItems: "center", gap: 8 }}>
        <Chip tone="warn">review &amp; fix</Chip>
        <span className="hud-label">
          {missing.length ? `${missing.length} field${missing.length === 1 ? "" : "s"} missing` : "no missing fields"}
        </span>
        <div style={{ flex: 1 }} />
        {pdf?.url && (
          <a href={pdf.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: "var(--accent)" }}>
            open PDF in new tab ↗
          </a>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(260px, 1fr)", gap: 0, height: "clamp(520px, calc(100vh - 310px), 760px)", minHeight: 0 }}>
        <div style={{ minHeight: 0, background: "var(--bg-void)", borderRight: "1px solid var(--edge)", overflow: "hidden" }}>
          {pdfLoading && <div style={{ padding: 18, color: "var(--text-dim)", fontSize: 12 }}>loading PDF…</div>}
          {pdfError && <div style={{ padding: 18, color: "var(--warn)", fontSize: 12 }}>{pdfError}</div>}
          {pdf?.url && !pdfError && (
            <PdfCanvasViewer url={pdf.url} title="Statement PDF" password={pdf.password} initialScale={0.95} />
          )}
          {pdf?.password && (
            <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-dim)", borderTop: "1px solid var(--edge)" }}>
              PDF unlocked with saved password.
            </div>
          )}
        </div>
        <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10, minHeight: 0, overflowY: "auto" }}>
          <div className="hud-label">Missing fields — read the PDF on the left and fill:</div>
          {missing.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--ok)" }}>all fields present · nothing to correct</div>
          )}
          {missing.map((k) => (
            <div key={k} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <label style={labelStyle}>{LABELS[k]}</label>
              <input
                type={DATE_FIELDS.includes(k as any) ? "date" : AMOUNT_FIELDS.includes(k as any) ? "number" : "text"}
                inputMode={AMOUNT_FIELDS.includes(k as any) ? "decimal" : undefined}
                min={AMOUNT_FIELDS.includes(k as any) ? 0 : undefined}
                step={AMOUNT_FIELDS.includes(k as any) ? "0.01" : undefined}
                maxLength={k === "card_last4" ? 4 : undefined}
                value={values[k] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                style={inputStyle}
              />
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <Btn size="sm" variant="primary" disabled={saving || missing.length === 0} onClick={save}>
              {saving ? "saving…" : "save & learn"}
            </Btn>
          </div>
          {lastLearned && lastLearned.fields.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>learned anchors:</span>
              {lastLearned.fields.map((f) => (
                <Chip key={f} tone="ok">{LABELS[f as FieldKey] ?? f}</Chip>
              ))}
              {lastLearned.siblings > 0 && (
                <Chip tone="ok">+{lastLearned.siblings} sibling{lastLearned.siblings === 1 ? "" : "s"} auto-parsed</Chip>
              )}
            </div>
          )}
          <div style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.4 }}>
            Corrections don't just save — they train the parser. Each value you enter is located in the PDF, its label captured, and stored for this bank + layout so the next statement fills these fields on its own. Transaction rows still come from the extractor.
          </div>
        </div>
      </div>
    </div>
  );
}
