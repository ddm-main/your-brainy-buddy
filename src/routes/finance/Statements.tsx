import { Fragment, useEffect, useMemo, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { PdfCanvasViewer } from "@/components/finance/PdfCanvasViewer";
import { db, inr } from "@/lib/db";
import { gmail } from "@/lib/gmail";
import { useUi } from "@/store/uiStore";
import { StatementReviewPanel, missingFieldsFor } from "./StatementReviewPanel";


// ---------- Statements ----------
function statusTone(status: string | null | undefined): "neutral" | "ok" | "warn" | "err" {
  if (status === "parsed") return "ok";
  if (status === "failed") return "err";
  if (status === "pending") return "warn";
  if (status === "skipped") return "warn";
  return "neutral";
}

function statementStatusLabel(s: any): string {
  const status = s.parse_status ?? "manual";
  if (status === "skipped") return "failed";
  if (status === "pending") return "failed";
  if (status === "failed") return "failed";
  if (status !== "parsed") return status;
  if (s.statement_type === "card" && (
    s.statement_date == null || s.due_date == null || s.total_due == null || Number(s.transactions_found ?? 0) === 0
  )) return "parsed · incomplete";
  return "parsed";
}

// Human-friendly parse_error → hint used in the row hint and expanded panel.
function explainParseError(err: string | null | undefined): string | null {
  if (!err) return null;
  switch (err) {
    case "wrong_or_missing_password":
    case "wrong_password":
    case "password_required":
    case "password_missing":
    case "password_failed":
      return "PDF is password-protected — auto-password attempts failed. Enter it below and retry.";
    case "stored_password_unreadable":
      return "The saved password could not be read. Enter it again and retry.";
    case "no_pdf_attachment_login_required":
      return "No PDF attachment was available in Gmail — row is linked where possible, attach the PDF to parse details.";
    case "unlinked_no_entity_match":
      return "Bank was detected, but no saved card/account confidently matched this statement.";
    case "statement_update_failed":
      return "Statement metadata could not be saved during an older parser run — retry this row.";
    case "schema_cache_miss":
      return "Database cache was out of date — it has been reloaded, retry the row.";
    case "unknown_parse_error":
      return "Parser could not complete required fields — retry with the improved parser, or attach/link the correct PDF.";
    case "no_pdf_available":
      return "No stored PDF or source email is available — attach the PDF manually.";
    case "reparse_crashed":
      return "Reparse crashed during the previous run — retry this row.";
    case "file_too_large":
      return "PDF exceeds the 20 MB size limit.";
    case "too_many_pages":
      return "PDF has too many pages to parse (limit 100).";
    case "gmail_fetch_failed":
      return "Gmail could not return this message — the mailbox may need to be reconnected in Config → Email.";
    case "gmail_payload_empty":
      return "Gmail returned an empty message payload for this statement — try re-syncing the mailbox.";
    case "attachment_download_failed":
      return "The PDF attachment failed to download from Gmail — retry, or attach the PDF manually.";
    case "storage_upload_failed":
      return "The PDF downloaded but could not be stored — retry the row.";
    case "attachment_row_insert_failed":
    case "attachment_row_update_failed":
    case "attachment_row_missing":
      return "Internal bookkeeping error for this attachment — retry the row.";
    case "ingest_crashed":
      return "Ingestion crashed unexpectedly — retry, or attach the PDF manually.";
    default:
      return err;
  }
}

// Best-effort display label for a statement row when no card/account is linked.
function rowIdentity(s: any): { bank: string | null; entity: string | null } {
  const cardBank = s.credit_cards?.banks?.name ?? null;
  const acctBank = s.financial_accounts?.banks?.name ?? null;
  const linkedBank = s.banks?.name ?? null;
  const bank = cardBank ?? acctBank ?? linkedBank ?? null;
  const entity =
    s.credit_cards?.card_name ??
    s.financial_accounts?.nickname ??
    s.loans?.lender_name ??
    null;
  return { bank, entity };
}

function linkReason(s: any): string | null {
  if (s.credit_card_id || s.financial_account_id || s.loan_id) return null;
  if (s.banks?.name) return "bank matched · entity unlinked";
  return "bank + entity not matched";
}

function needsReparse(s: any): boolean {
  if (["pending", "failed", "skipped"].includes(s.parse_status ?? "")) return true;
  if (s.parse_status !== "parsed") return false;
  // Accounts are info-only — no due/total lifecycle to complete. Never
  // treat an account row as "incomplete" for missing card-only fields.
  if (s.statement_type === "account") return false;
  if (s.statement_type === "card" && (s.statement_date == null || s.due_date == null || s.total_due == null)) return true;
  return Number(s.transactions_found ?? 0) === 0;
}

/** One inline label+value pair in the expanded statement row. Inline (not
 * stacked over a <br/>) so the whole fact set fits on a single line. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 5, whiteSpace: "nowrap" }}>
      <span className="hud-label">{label}</span>
      <span style={{ color: "var(--text)" }}>{value}</span>
    </span>
  );
}

// DD-MM-YYYY formatter — accepts ISO or Date-parseable string.
function fmtDMY(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (!(dt instanceof Date) || isNaN(dt.getTime())) return "—";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${dt.getFullYear()}`;
}

// Display "XX 6560" from a masked_number like "434155XXXXXX6560" or a raw last4.
function cardNoDisplay(s: any): string {
  const raw: string = s.credit_cards?.masked_number ?? s.card_last4 ?? "";
  if (!raw) return "—";
  const m = String(raw).match(/(\d{4})\s*$/);
  return m ? `XX ${m[1]}` : String(raw);
}

// Compute Yes/No validated + reason for a card row (without needing txns loaded).
function cardValidated(s: any): { ok: boolean; reason: string } {
  if (s.parse_status !== "parsed") return { ok: false, reason: s.parse_status ?? "not parsed" };
  const missing: string[] = [];
  if (s.statement_date == null) missing.push("statement date");
  if (s.due_date == null) missing.push("due date");
  if (s.total_due == null) missing.push("total due");
  if (Number(s.transactions_found ?? 0) === 0) missing.push("transactions");
  if (missing.length > 0) return { ok: false, reason: `missing ${missing.join(", ")}` };
  return { ok: true, reason: "" };
}

export default function Statements() {
  const push = useUi((s) => s.push);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [txnsModalId, setTxnsModalId] = useState<string | null>(null);
  const [fixModalId, setFixModalId] = useState<string | null>(null);
  const [txns, setTxns] = useState<any[]>([]);
  const [txnsLoading, setTxnsLoading] = useState(false);
  const [cards, setCards] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loans, setLoans] = useState<any[]>([]);
  const [emailAccounts, setEmailAccounts] = useState<any[]>([]);

  const [retryLinkId, setRetryLinkId] = useState("");
  const [retryPassword, setRetryPassword] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [retryingAll, setRetryingAll] = useState(false);
  const [rowRetryingId, setRowRetryingId] = useState<string | null>(null);

  const [pdfViewer, setPdfViewer] = useState<{ statementId: string; title: string; url: string | null; password: string | null; loading: boolean; error: string | null } | null>(null);

  const [showUpload, setShowUpload] = useState(false);
  const [uploadType, setUploadType] = useState<"card" | "account" | "loan">("card");
  const [uploadEntityId, setUploadEntityId] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPassword, setUploadPassword] = useState("");
  const [uploading, setUploading] = useState(false);
  const [attachTargetId, setAttachTargetId] = useState<string | null>(null); // existing_statement_id when attaching

  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterType, setFilterType] = useState<string>("card");
  const [filterUnlinked, setFilterUnlinked] = useState<boolean>(false);


  const [fetchAccountId, setFetchAccountId] = useState<string>("");
  const [fetchPeriodDays, setFetchPeriodDays] = useState<string>("90");
  const [fetching, setFetching] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setItems(await db.statements.list()); }
    finally { setLoading(false); }
  };

  // Fetch statements from Gmail: run gmail-sync for the chosen account, then
  // finance-extract with the chosen period. Auto-refreshes the list.
  const fetchFromGmail = async () => {
    if (!fetchAccountId) { push("Pick an email account first", "warn"); return; }
    setFetching(true);
    try {
      push("Syncing Gmail…", "ok");
      const s = await gmail.sync(fetchAccountId, 200);
      push(`Gmail: ${s.inserted} new / ${s.total} scanned`, "ok");
      const days = Math.max(1, Math.min(365, Number(fetchPeriodDays) || 90));
      const r: any = await db.finance.extract({ account_id: fetchAccountId, since_days: days, limit: 500 });
      push(`Extract: ${r.transactions ?? 0} txns · ${r.statements ?? 0} statements`, "ok");
      await load();
    } catch (e: any) {
      const msg = String(e?.message ?? "Fetch failed");
      if (/invalid[_ ]grant|unauthorized|401|insufficient[_ ]?scope|token|refresh/i.test(msg)) {
        push("Gmail access expired — reconnect this mailbox in Config → Email", "err");
      } else {
        push(msg, "err");
      }
    } finally { setFetching(false); }
  };

  // Re-parse unresolved rows using server-side password rotation.
  // 'skipped' rows have no PDF attached — bulk retry can't help them, they
  // need a manual "attach PDF". Only bulk-retry rows the server can act on.
  const reparseUnresolved = async () => {
    const targets = items.filter(needsReparse);
    if (targets.length === 0) return;
    setRetryingAll(true);
    try {
      // The edge function processes a tiny batch per call (CPU-bound PDF
      // parsing hits the worker's ~2s limit). Loop until nothing's left, or
      // we detect no forward progress — a broken row would otherwise churn
      // 40 batches producing 40 identical toasts.
      let totalParsed = 0;
      let totalScanned = 0;
      let remaining = targets.length;
      let throttled = 0;
      let lastRemaining = -1;
      let noProgress = 0;
      for (let i = 0; i < 20; i++) {
        const res: any = await db.statements.reparseAll({ limit: 3 });
        totalParsed += res?.parsed ?? 0;
        totalScanned += res?.scanned ?? 0;
        remaining = res?.remaining_after ?? 0;
        throttled = res?.throttled ?? 0;
        if (!remaining || (res?.scanned ?? 0) === 0) break;
        // Everything left is on cool-down or over the attempt cap.
        if (remaining > 0 && remaining === throttled) break;
        // Two consecutive no-progress batches → stop.
        if ((res?.parsed ?? 0) === 0 && remaining === lastRemaining) {
          noProgress++;
          if (noProgress >= 2) break;
        } else {
          noProgress = 0;
        }
        lastRemaining = remaining;
      }
      const tone = remaining === 0 ? "ok" : throttled >= remaining ? "info" : "warn";
      const suffix = throttled > 0 && remaining > 0 ? ` (${throttled} throttled — retry manually)` : "";
      push(`Reparse done · ${totalParsed}/${totalScanned} parsed · ${remaining} left${suffix}`, tone);
      await load();
    } finally { setRetryingAll(false); }
  };


  useEffect(() => {
    load();
    db.cards.list().then(setCards).catch(() => {});
    db.accounts.list().then(setAccounts).catch(() => {});
    db.loans.list().then(setLoans).catch(() => {});
    db.emailAccounts.list().then((a) => {
      // Only show mailboxes we can actually sync from here.
      const usable = (a ?? []).filter((x: any) =>
        x.provider === "gmail" && x.connected_at && !x.paused_at);
      setEmailAccounts(usable);
      if (usable.length && !fetchAccountId) setFetchAccountId(usable[0].id);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const title = s.emails?.subject ?? rowIdentity(s).entity ?? "Statement PDF";
    setPdfViewer({ statementId: s.id, title, url: null, password: null, loading: true, error: null });
    try {
      const pdf = await db.statements.signedPdfUrl(s.id);
      setPdfViewer({ statementId: s.id, title, url: pdf.url, password: pdf.password, loading: false, error: null });
    } catch (e: any) {
      const msg = e?.message ?? "failed to open PDF";
      setPdfViewer({ statementId: s.id, title, url: null, password: null, loading: false, error: msg });
      push(msg, "err");
    }
  };

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
        push(`Retry failed: ${explainParseError(res?.parse_error) ?? "unknown error"}`, "err");
      } else if (res?.parse_status === "parsed") {
        push("Parsed", "ok");
      } else {
        push(`Retry did not finish: ${res?.parse_reason ?? res?.parse_status ?? "unknown"}`, "warn");
      }
      setRetryLinkId("");
      setRetryPassword("");
      await load();
      setTxns(await db.statements.transactions(s.id));
    } catch (e: any) { push(e?.message ?? "retry failed", "err"); }
    finally { setRetrying(false); }
  };

  // Per-row quick retry — no link override, no password. Uses whatever's
  // already saved on the statement (bank + link + stored password). Lets
  // the user re-parse ONE row without expanding it or bulk-retrying all.
  const retryRow = async (s: any) => {
    setRowRetryingId(s.id);
    try {
      const res: any = await db.statements.retry(s.id);
      if (res?.parse_status === "failed") {
        push(`Retry failed: ${explainParseError(res?.parse_error) ?? "unknown error"}`, "err");
      } else if (res?.parse_status === "parsed") {
        push("Parsed", "ok");
      } else {
        push(`Retry did not finish: ${res?.parse_reason ?? res?.parse_status ?? "unknown"}`, "warn");
      }
      const fresh = await db.statements.list();
      setItems(fresh);
      if (openId === s.id) {
        try { setTxns(await db.statements.transactions(s.id)); } catch { /* ignore */ }
      }
    } catch (e: any) {
      push(e?.message ?? "retry failed", "err");
      try { setItems(await db.statements.list()); } catch { /* keep current rows */ }
    }
    finally { setRowRetryingId(null); }
  };


  // Save just the link (no reparse) — for forwarded-email rows where the
  // parser can't detect the bank but you know which card/account it is.
  // Also clears the "unknown_parse_error" banner and kicks off a retry so
  // the row reflects the user's chosen bank on the next parse pass.
  const saveLinkOnly = async (s: any) => {
    if (!retryLinkId) { push("Choose a card or account first", "warn"); return; }
    setRetrying(true);
    try {
      const link = cards.some((c) => c.id === retryLinkId)
        ? { credit_card_id: retryLinkId, financial_account_id: null }
        : { credit_card_id: null, financial_account_id: retryLinkId };
      await db.statements.saveLink(s.id, link);
      // Fire-and-forget retry — the edge function re-parses using the
      // user's link and refreshes parse_status. Don't block the toast on
      // it; user sees "Link saved" immediately and the row refreshes when
      // load() finishes below.
      db.statements.retry(s.id, link, retryPassword || undefined).catch(() => {});
      push("Link saved — re-parsing…", "ok");
      setRetryLinkId("");
      setRetryPassword("");
      await load();
    } catch (e: any) { push(e?.message ?? "failed to save link", "err"); }
    finally { setRetrying(false); }
  };

  // Open the upload form pre-populated to attach a PDF to a specific
  // (usually skipped) statement row.
  const startAttachToRow = (s: any) => {
    setAttachTargetId(s.id);
    setUploadType((s.statement_type as any) ?? "card");
    setUploadEntityId(s.credit_card_id ?? s.financial_account_id ?? s.loan_id ?? "");
    setUploadFile(null);
    setUploadPassword("");
    setShowUpload(true);
  };

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
        filename: uploadFile.name, contentType: uploadFile.type || "application/pdf", bytesBase64, password: uploadPassword || undefined,
        existing_statement_id: attachTargetId || undefined,
      });
      if (res?.duplicate) push("Statement already uploaded — opened existing", "ok");
      else if (res?.parse_status === "failed") push(`Uploaded, but parse failed: ${explainParseError(res?.parse_error) ?? "unknown"}`, "err");
      else if (res?.parse_status === "parsed") push("Statement uploaded and parsed", "ok");
      else push("Statement uploaded", "ok");
      setShowUpload(false); setUploadEntityId(""); setUploadFile(null); setUploadPassword(""); setAttachTargetId(null);
      load();
    } catch (e: any) { push(e?.message ?? "upload failed", "err"); }
    finally { setUploading(false); }
  };

  const entityOptions = uploadType === "card" ? cards.map((c: any) => ({ value: c.id, label: c.card_name }))
    : uploadType === "account" ? accounts.map((a: any) => ({ value: a.id, label: a.nickname }))
    : loans.map((l: any) => ({ value: l.id, label: l.lender_name }));

  const filtered = useMemo(() => items.filter((s) => {
    if (filterStatus && (s.parse_status ?? "manual") !== filterStatus) return false;
    if (filterType && s.statement_type !== filterType) return false;
    if (filterUnlinked && (s.credit_card_id || s.financial_account_id || s.loan_id)) return false;
    return true;
  }), [items, filterStatus, filterType, filterUnlinked]);

  const typeCounts = useMemo(() => {
    const c = { card: 0, account: 0, loan: 0 };
    for (const s of items) {
      if (s.statement_type === "card") c.card++;
      else if (s.statement_type === "account") c.account++;
      else if (s.statement_type === "loan") c.loan++;
    }
    return c;
  }, [items]);

  const markPaid = async (s: any) => {
    try {
      await db.statements.markPaid(s.id, s.total_due ?? null);
      push("Marked paid", "ok");
      await load();
    } catch (e: any) { push(e?.message ?? "failed to mark paid", "err"); }
  };
  const clearPayment = async (s: any) => {
    try {
      await db.statements.clearPayment(s.id);
      push("Payment reset", "ok");
      await load();
    } catch (e: any) { push(e?.message ?? "failed", "err"); }
  };


  const validationFor = (s: any, statementTxns: any[]): { ok: boolean; msg: string } | null => {
    if (s.parse_status !== "parsed" || s.total_due == null || statementTxns.length === 0) return null;
    const sumDeb = statementTxns.filter((t) => t.txn_type === "debit").reduce((a, t) => a + Number(t.amount ?? 0), 0);
    if (sumDeb === 0) return null;
    const diff = Math.abs(sumDeb - Number(s.total_due));
    const pct = diff / Number(s.total_due);
    if (pct < 0.01) return { ok: true, msg: `lines total matches due (${inr(sumDeb)})` };
    return { ok: false, msg: `lines total ${inr(sumDeb)} vs due ${inr(s.total_due)} — off by ${inr(diff)}` };
  };

  const unresolvedCount = items.filter(needsReparse).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}>
      {pdfViewer && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Statement PDF viewer"
          onClick={() => setPdfViewer(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 80,
            background: "rgba(0, 0, 0, 0.72)",
            display: "flex",
            flexDirection: "column",
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 10px",
              border: "1px solid var(--edge)",
              background: "var(--panel-tint-heavy)",
              flexShrink: 0,
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="hud-label">statement PDF</div>
              <div style={{ color: "var(--text)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={pdfViewer.title}>{pdfViewer.title}</div>
            </div>
            {pdfViewer.url && (
              <a href={pdfViewer.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", fontSize: 11, fontFamily: "var(--font-hud)", textTransform: "uppercase", letterSpacing: "0.12em" }}>
                open external
              </a>
            )}
            <Btn size="sm" onClick={() => setPdfViewer(null)}>close</Btn>
          </div>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              minHeight: 0,
              flex: 1,
              border: "1px solid var(--edge)",
              borderTop: "none",
              background: "var(--bg)",
            }}
          >
            {pdfViewer.loading ? (
              <div className="hud-label" style={{ padding: 18 }}>loading PDF…</div>
            ) : pdfViewer.error ? (
              <div style={{ padding: 18, color: "var(--warn)", fontSize: 12 }}>{pdfViewer.error}</div>
            ) : pdfViewer.url ? (
              <PdfCanvasViewer url={pdfViewer.url} title={pdfViewer.title} password={pdfViewer.password} />
            ) : null}
          </div>
        </div>
      )}
      <HudPanel title="Statements" index="STM" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-hidden flex flex-col"
        actions={<>
          {unresolvedCount > 0 && (
            <Btn size="sm" onClick={reparseUnresolved} disabled={retryingAll}>
              {retryingAll ? "re-parsing…" : `re-parse incomplete (${unresolvedCount})`}
            </Btn>
          )}
          <Btn size="sm" onClick={() => { setAttachTargetId(null); setShowUpload((v) => !v); }}>+ upload statement</Btn>
        </>}>

        {/* Single-row toolbar: fetch + type tabs + filters */}
        <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "4px 6px", marginBottom: 8, border: "1px solid var(--edge)", borderRadius: 2, overflow: "hidden" }}>
          <HudSelect value={fetchAccountId} onChange={setFetchAccountId}
            placeholder={emailAccounts.length ? "mailbox" : "no mailbox"}
            style={{ maxWidth: 140, flex: "0 1 auto" }}
            options={emailAccounts.map((a) => ({ value: a.id, label: a.email_address }))} />
          <HudSelect value={fetchPeriodDays} onChange={setFetchPeriodDays}
            style={{ width: 56, flex: "0 0 auto" }}
            options={[
              { value: "7", label: "7d" },
              { value: "30", label: "30d" },
              { value: "90", label: "90d" },
              { value: "180", label: "6mo" },
              { value: "365", label: "12mo" },
            ]} />
          <Btn size="sm" variant="primary" disabled={fetching || !fetchAccountId} onClick={fetchFromGmail}>
            {fetching ? "…" : "fetch"}
          </Btn>
          <div style={{ width: 1, height: 18, background: "var(--edge)", margin: "0 2px", flex: "0 0 auto" }} />
          {([
            { key: "card",    label: `C ${typeCounts.card}` },
            { key: "account", label: `A ${typeCounts.account}` },
            { key: "loan",    label: `L ${typeCounts.loan}` },
            { key: "",        label: "All" },
          ] as const).map((t) => (
            <button key={t.key || "all"} onClick={() => setFilterType(t.key)}
              style={{
                padding: "3px 7px",
                background: filterType === t.key ? "var(--panel-tint-heavy)" : "transparent",
                color: filterType === t.key ? "var(--accent)" : "var(--text-dim)",
                border: "1px solid " + (filterType === t.key ? "var(--accent)" : "var(--edge)"),
                borderRadius: 2, fontSize: 10, fontFamily: "var(--font-hud)",
                letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer",
                flex: "0 0 auto", whiteSpace: "nowrap",
              }}
            >{t.label}</button>
          ))}
          <div style={{ width: 1, height: 18, background: "var(--edge)", margin: "0 2px", flex: "0 0 auto" }} />
          <HudSelect value={filterStatus} onChange={setFilterStatus} placeholder="status"
            style={{ width: 86, flex: "0 0 auto" }}
            options={[
              { value: "", label: "all" },
              { value: "parsed", label: "parsed" },
              { value: "failed", label: "failed" },
            ]} />
          <Btn size="sm" variant={filterUnlinked ? "primary" : undefined} onClick={() => setFilterUnlinked((v) => !v)} style={{ padding: "3px 7px" }}>unlinked</Btn>
          <div style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-hud)", letterSpacing: "0.12em", textTransform: "uppercase", flex: "0 0 auto" }}>
            {filtered.length}/{items.length}
          </div>
        </div>



        {showUpload && (
          <div style={{ padding: 10, border: "1px dashed var(--edge)", marginBottom: 10, display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
            {attachTargetId && (
              <div style={{ width: "100%", fontSize: 11, color: "var(--accent)", marginBottom: 4 }}>
                Attaching PDF to existing statement row (id: {attachTargetId.slice(0, 8)}…)
              </div>
            )}
            <div>
              <label style={labelStyle}>type</label>
              <HudSelect value={uploadType} onChange={(v) => { setUploadType(v as any); if (!attachTargetId) setUploadEntityId(""); }} options={[
                { value: "card", label: "card" }, { value: "account", label: "account" }, { value: "loan", label: "loan" },
              ]} />
            </div>
            <div style={{ minWidth: 200 }}>
              <label style={labelStyle}>which one</label>
              <HudSelect value={uploadEntityId} onChange={setUploadEntityId} placeholder="—" options={entityOptions} />
            </div>
            <div>
              <label style={labelStyle}>PDF file</label>
              <input type="file" accept="application/pdf" onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} style={{ ...inputStyle }} />
            </div>
            <div>
              <label style={labelStyle}>password (optional)</label>
              <input type="password" value={uploadPassword} onChange={(e) => setUploadPassword(e.target.value)} placeholder="auto-try saved" style={{ ...inputStyle, width: 160 }} />
            </div>
            <Btn size="sm" variant="primary" disabled={uploading || !uploadFile || !uploadEntityId} onClick={doUpload}>{uploading ? "uploading…" : "upload"}</Btn>
            <Btn size="sm" onClick={() => { setShowUpload(false); setAttachTargetId(null); }}>cancel</Btn>
          </div>
        )}

        {loading ? <div className="hud-label">loading…</div> :
         filtered.length === 0 ? <EmptyState hint="click 'fetch statements' above, or upload a PDF manually">no statements match</EmptyState> :
          <div className="stmt-scroll" style={{ flex: "1 1 0", minHeight: 0, maxHeight: "100%", overflowY: "auto", overflowX: "auto", scrollbarGutter: "stable", borderTop: "1px solid rgba(127,233,255,0.12)", borderBottom: "1px solid rgba(127,233,255,0.12)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead style={{ position: "sticky", top: 0, zIndex: 1, background: "var(--panel-tint-heavy)" }}>
             <tr style={{ color: "var(--text-dim)", textAlign: "left", fontSize: 10, fontFamily: "var(--font-hud)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
               <th style={{ padding: "4px 8px", borderBottom: "1px solid var(--edge)", width: "26%" }}>entity</th>
               <th style={{ padding: "4px 8px", borderBottom: "1px solid var(--edge)", width: "20%" }}>period</th>
               <th style={{ padding: "4px 8px", borderBottom: "1px solid var(--edge)", width: "18%", textAlign: "right" }}>amounts</th>
               <th style={{ padding: "4px 8px", borderBottom: "1px solid var(--edge)", width: "18%" }}>status</th>
               <th style={{ padding: "4px 8px", borderBottom: "1px solid var(--edge)", textAlign: "right" }}>actions</th>
             </tr>
           </thead>
           <tbody>
             {filtered.map((s: any) => {
               const { bank, entity } = rowIdentity(s);
               const em = s.emails ?? null;
               const dateStr = s.statement_date
                 ? new Date(s.statement_date).toLocaleDateString()
                 : em?.received_at ? new Date(em.received_at).toLocaleDateString() : "—";
               const hint = explainParseError(s.parse_error);
               const unlinkedReason = linkReason(s);
               const rawErr = s.parse_error ?? "";
               const isCard = s.statement_type === "card";
               const incomplete = s.parse_status === "parsed" && isCard && (
                 s.statement_date == null || s.due_date == null || s.total_due == null ||
                 Number(s.transactions_found ?? 0) === 0
               );
               const statusLabel = statementStatusLabel(s);
               const statusToneVal = incomplete ? "warn" : statusTone(s.parse_status);
               return (
                 <Fragment key={s.id}>
                   <tr style={{ borderBottom: "1px solid rgba(127,233,255,0.06)", cursor: "pointer" }} onClick={() => toggleOpen(s)}>
                     <td style={{ padding: "4px 8px", verticalAlign: "middle" }}>
                       <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                         <span style={{ color: "var(--text)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{bank ?? "Unknown bank"}</span>
                         <Chip>{s.statement_type}</Chip>
                       </div>
                       <div style={{ color: "var(--text-dim)", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                         {entity ?? <span style={{ color: "var(--warn)" }}>unlinked</span>}
                       </div>
                       {unlinkedReason && <div style={{ color: "var(--warn)", fontSize: 9, marginTop: 1 }}>{unlinkedReason}</div>}
                     </td>
                     <td style={{ padding: "4px 8px", color: "var(--text-dim)", verticalAlign: "middle", fontSize: 11, whiteSpace: "nowrap" }}>
                       <div>{dateStr}</div>
                       <div>{s.period_start && s.period_end ? `${s.period_start} → ${s.period_end}` : "—"}</div>
                       <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 1 }}>{s.transactions_found ?? 0} txns</div>
                     </td>
                     <td style={{ padding: "4px 8px", verticalAlign: "middle", textAlign: "right", fontSize: 11, whiteSpace: "nowrap" }}>
                       <div style={{ color: "var(--text)", fontWeight: 500 }}>{s.total_due != null ? inr(s.total_due) : (s.closing_balance != null ? inr(s.closing_balance) : "—")}</div>
                       <div style={{ color: "var(--text-dim)" }}>
                         {isCard ? (
                           <>
                             {s.min_due != null ? `min ${inr(s.min_due)}` : "—"}
                             {" · "}
                             {s.credit_limit != null ? `lim ${inr(s.credit_limit)}` : "—"}
                           </>
                         ) : (
                           s.due_date ? `due ${new Date(s.due_date).toLocaleDateString()}` : "—"
                         )}
                       </div>
                     </td>
                     <td style={{ padding: "4px 8px", verticalAlign: "middle" }}>
                       <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                         <Chip tone={statusToneVal}>{statusLabel}</Chip>
                         {isCard && s.payment_status && s.payment_status !== "na" && (
                           <Chip tone={s.payment_status === "paid" ? "ok" : s.payment_status === "overdue" ? "err" : "warn"}>{s.payment_status}</Chip>
                         )}
                       </div>
                     </td>
                     <td style={{ padding: "4px 8px", verticalAlign: "middle", textAlign: "right" }}>
                       <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", flexWrap: "wrap" }}>
                         {s.file_path ? (
                           <Btn size="sm" onClick={(e: any) => { e.stopPropagation(); viewPdf(s); }}>PDF</Btn>
                         ) : <span className="hud-label">—</span>}
                         {(s.file_path || s.source_email_id || s.parse_status === "failed" || s.parse_status === "skipped") && (
                           <Btn
                             size="sm"
                             disabled={rowRetryingId === s.id}
                             onClick={(e: any) => { e.stopPropagation(); retryRow(s); }}
                             title={s.file_path || s.source_email_id
                               ? "Re-parse just this statement"
                               : "Retry — attach a PDF first if none is linked"}
                           >
                             {rowRetryingId === s.id ? "…" : "retry"}
                           </Btn>
                         )}
                       </div>
                     </td>
                   </tr>
                    {openId === s.id && (
                      <tr>
                        <td colSpan={5} style={{ padding: "8px", background: "rgba(53,214,237,0.03)", borderBottom: "1px solid rgba(127,233,255,0.06)" }}>
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {/* Compact metadata + quick actions bar */}
                            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", fontSize: 11 }}>
                              {isCard && s.parse_status === "parsed" && (
                                <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 4 }}>
                                  {s.payment_status !== "paid" && <Btn size="sm" variant="primary" onClick={() => markPaid(s)}>mark paid</Btn>}
                                  {(s.payment_status === "paid" || s.payment_status === "partial") && <Btn size="sm" onClick={() => clearPayment(s)}>clear payment</Btn>}
                                </div>
                              )}
                              {(() => {
                                const v = validationFor(s, txns);
                                const paid = isCard && s.paid_amount != null;
                                const attach = s.parse_status === "skipped";
                                if (!v && !paid && !attach) return null;
                                return (
                                  <>
                                    {paid && <Fact label="paid" value={`${inr(s.paid_amount)}${s.paid_on ? ` · ${new Date(s.paid_on).toLocaleDateString()}` : ""}`} />}
                                    {v && (
                                      <span title={v.msg} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                        <Chip tone={v.ok ? "ok" : "warn"}>{v.ok ? "validated" : "mismatch"}</Chip>
                                        <span style={{ color: v.ok ? "var(--ok)" : "var(--warn)" }}>{v.msg}</span>
                                      </span>
                                    )}
                                    {attach && <Btn size="sm" variant="primary" onClick={() => startAttachToRow(s)}>attach PDF →</Btn>}
                                  </>
                                );
                              })()}
                              {s.parse_status === "parsed" && (() => {
                                let missing: string[] = [];
                                const mErr = /missing_fields:([\w,]+)/i.exec(s.parse_error ?? "");
                                if (mErr) missing = mErr[1].split(",").filter(Boolean);
                                else missing = missingFieldsFor(s) as string[];
                                if (Number(s.transactions_found ?? 0) === 0 && s.statement_type !== "loan") missing.push("transactions");
                                if (missing.length === 0) return null;
                                return <span style={{ color: "var(--warn)" }}>missing: {missing.join(", ")}</span>;
                              })()}
                              {!s.skeleton_id && Number(s.learn_attempts ?? 0) > 0 && (
                                <span style={{ color: "var(--warn)", fontSize: 10 }}>learn: {s.learn_attempts}×</span>
                              )}
                              {hint && s.parse_status !== "parsed" && hint !== s.parse_reason && hint !== s.parse_error && (
                                <span style={{ color: "var(--warn)", fontSize: 10 }}>{hint}</span>
                              )}
                            </div>
                            {(hint || rawErr) && s.parse_status !== "parsed" && (
                              <div style={{ padding: "4px 8px", background: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.25)", borderRadius: 4, color: "var(--warn)", fontSize: 11 }}>
                                <span className="hud-label" style={{ color: "var(--warn)" }}>{rawErr || "parse_error"}</span>
                                {hint && hint !== rawErr ? <> · {hint}</> : null}
                              </div>
                            )}
                            {(s.parse_status === "failed" || s.parse_status === "pending" || needsReparse(s) || (!s.credit_card_id && !s.financial_account_id && !s.loan_id)) && (
                              <div style={{ display: "flex", gap: 6, alignItems: "end", flexWrap: "wrap" }}>
                                <div style={{ minWidth: 240 }}>
                                  <label style={labelStyle}>link to card / account</label>
                                  <HudSelect value={retryLinkId} onChange={setRetryLinkId} placeholder="—" options={[
                                    ...cards.map((c: any) => ({ value: c.id, label: `${c.card_name} (card${c.banks?.name ? ` · ${c.banks.name}` : ""})` })),
                                    ...accounts.map((a: any) => ({ value: a.id, label: `${a.nickname} (account${a.banks?.name ? ` · ${a.banks.name}` : ""})` })),
                                  ]} />
                                </div>
                                <div>
                                  <label style={labelStyle}>password</label>
                                  <input type="password" value={retryPassword} onChange={(e) => setRetryPassword(e.target.value)} placeholder="auto-try saved" style={{ ...inputStyle, width: 160 }} />
                                </div>
                                <Btn size="sm" variant="primary" disabled={retrying} onClick={() => retryStatement(s)}>{retrying ? "retrying…" : "retry"}</Btn>
                                <Btn size="sm" disabled={retrying || !retryLinkId} onClick={() => saveLinkOnly(s)} title="Save the chosen card/account without re-parsing the PDF">save link only</Btn>
                              </div>
                            )}
                            {(missingFieldsFor(s).length > 0 || Number(s.transactions_found ?? 0) === 0) && s.parse_status !== "pending" && (
                              <StatementReviewPanel
                                statement={s}
                                onSaved={(patch) => {
                                  setItems((prev) => prev.map((x) => x.id === s.id ? { ...x, ...patch, manual_override: true, parse_status: "parsed" } : x));
                                }}
                              />
                            )}
                            <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                              <span className="hud-label" style={{ flex: "0 0 auto" }}>txns ({s.transactions_found ?? 0})</span>
                              {txnsLoading ? <span className="hud-label">loading…</span> :
                               txns.length === 0 ? <span className="hud-label">none extracted</span> :
                               <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                                 {txns.map((t: any) => (
                                   <div key={t.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11 }}>
                                     <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{new Date(t.txn_date).toLocaleDateString()} · {t.merchant ?? "—"}</span>
                                     <span style={{ color: t.txn_type === "debit" ? "var(--warn)" : "var(--ok)", flex: "0 0 auto" }}>{t.txn_type === "debit" ? "-" : "+"}{inr(t.amount)}</span>
                                   </div>
                                 ))}
                               </div>}
                            </div>
                            {s.ai_summary && (
                              <div style={{ padding: 6, border: "1px solid var(--edge)", background: "rgba(53,214,237,0.04)", whiteSpace: "pre-wrap", fontSize: 11, color: "var(--text)" }}>
                                <span className="hud-label">AI summary</span> {s.ai_summary}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                 </Fragment>
               );
             })}
           </tbody>
          </table>
          </div>}
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
