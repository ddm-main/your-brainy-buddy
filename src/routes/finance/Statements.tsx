import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { HudSelect } from "@/components/hud/HudSelect";
import { db, inr } from "@/lib/db";
import { gmail } from "@/lib/gmail";
import { useUi } from "@/store/uiStore";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ---------- Statements ----------
function statusTone(status: string | null | undefined): "neutral" | "ok" | "warn" | "err" {
  if (status === "parsed") return "ok";
  if (status === "failed") return "err";
  if (status === "pending") return "warn";
  return "neutral";
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
  if (s.statement_type === "card" && (s.statement_date == null || s.due_date == null || s.total_due == null)) return true;
  return Number(s.transactions_found ?? 0) === 0;
}

function PdfCanvasViewer({ url, title, password }: { url: string; title: string; password?: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<any>(null);
  const [doc, setDoc] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [scale, setScale] = useState(1.15);
  const [status, setStatus] = useState<"loading" | "rendering" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setPage(1);
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
          disableAutoFetch: true,
          disableStream: true,
          isEvalSupported: false,
        });
        return task.promise;
      })
      .then((loaded) => {
        if (!loaded) return;
        if (cancelled) {
          loaded.destroy().catch(() => {});
          return;
        }
        setDoc(loaded);
        setPages(loaded.numPages);
      })
      .catch((e) => {
        if (cancelled) return;
        setStatus("error");
        setError(e?.message ?? "PDF could not be rendered in the app");
      });

    return () => {
      cancelled = true;
      task?.destroy?.();
      renderTaskRef.current?.cancel?.();
    };
  }, [url, password]);

  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let cancelled = false;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    if (!context) return;

    renderTaskRef.current?.cancel?.();
    setStatus("rendering");
    setError(null);

    doc.getPage(page)
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
        const renderTask = pdfPage.render({ canvasContext: context, viewport });
        renderTaskRef.current = renderTask;
        return renderTask.promise;
      })
      .then(() => {
        if (!cancelled) setStatus("ready");
      })
      .catch((e: any) => {
        if (cancelled || e?.name === "RenderingCancelledException") return;
        setStatus("error");
        setError(e?.message ?? "PDF could not be rendered in the app");
      });

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel?.();
    };
  }, [doc, page, scale]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--edge)", background: "var(--panel-tint)" }}>
        <Btn size="sm" disabled={!doc || page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹</Btn>
        <div className="hud-label" style={{ minWidth: 90, textAlign: "center" }}>{pages ? `${page} / ${pages}` : "—"}</div>
        <Btn size="sm" disabled={!doc || page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>›</Btn>
        <div style={{ flex: 1 }} />
        <Btn size="sm" disabled={!doc || scale <= 0.75} onClick={() => setScale((v) => Math.max(0.75, Number((v - 0.15).toFixed(2))))}>−</Btn>
        <div className="hud-label" style={{ minWidth: 48, textAlign: "center" }}>{Math.round(scale * 100)}%</div>
        <Btn size="sm" disabled={!doc || scale >= 2.25} onClick={() => setScale((v) => Math.min(2.25, Number((v + 0.15).toFixed(2))))}>+</Btn>
      </div>
      <div style={{ position: "relative", flex: 1, minHeight: 0, overflow: "auto", background: "var(--bg)", padding: 18, textAlign: "center" }}>
        {status !== "ready" && status !== "error" && (
          <div className="hud-label" style={{ position: "absolute", left: 18, top: 18 }}>{status === "loading" ? "loading PDF…" : "rendering PDF…"}</div>
        )}
        {error && <div style={{ padding: 18, color: "var(--warn)", fontSize: 12 }}>{error}</div>}
        <canvas
          ref={canvasRef}
          aria-label={title}
          style={{ display: error ? "none" : "inline-block", maxWidth: "100%", height: "auto", background: "#f8fafc", boxShadow: "0 0 0 1px rgba(127,233,255,0.18)" }}
        />
      </div>
    </div>
  );
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
  const [loans, setLoans] = useState<any[]>([]);
  const [emailAccounts, setEmailAccounts] = useState<any[]>([]);

  const [retryLinkId, setRetryLinkId] = useState("");
  const [retryPassword, setRetryPassword] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [retryingAll, setRetryingAll] = useState(false);
  const [summarizingId, setSummarizingId] = useState<string | null>(null);
  const [pdfViewer, setPdfViewer] = useState<{ statementId: string; title: string; url: string | null; password: string | null; loading: boolean; error: string | null } | null>(null);

  const [showUpload, setShowUpload] = useState(false);
  const [uploadType, setUploadType] = useState<"card" | "account" | "loan">("card");
  const [uploadEntityId, setUploadEntityId] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPassword, setUploadPassword] = useState("");
  const [uploading, setUploading] = useState(false);
  const [attachTargetId, setAttachTargetId] = useState<string | null>(null); // existing_statement_id when attaching

  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterType, setFilterType] = useState<string>("");
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
      // we bail out after a safety cap of iterations.
      let totalParsed = 0;
      let totalScanned = 0;
      let remaining = targets.length;
      for (let i = 0; i < 40; i++) {
        const res: any = await db.statements.reparseAll({ limit: 3 });
        totalParsed += res?.parsed ?? 0;
        totalScanned += res?.scanned ?? 0;
        remaining = res?.remaining_after ?? 0;
        push(`Batch ${i + 1}: ${res?.parsed ?? 0}/${res?.scanned ?? 0} parsed · ${remaining} left`, remaining ? "info" : "ok");
        if (!remaining || (res?.scanned ?? 0) === 0) break;
      }
      push(`Done · ${totalParsed}/${totalScanned} parsed · ${remaining} still need input`, remaining ? "warn" : "ok");
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
        push("Retry queued", "ok");
      }
      setRetryLinkId("");
      setRetryPassword("");
      await load();
      setTxns(await db.statements.transactions(s.id));
    } catch (e: any) { push(e?.message ?? "retry failed", "err"); }
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
      <HudPanel title="Statements" index="STM" live="ok" style={{ flex: 1, minHeight: 0 }} bodyClass="overflow-auto"
        actions={<>
          {unresolvedCount > 0 && (
            <Btn size="sm" onClick={reparseUnresolved} disabled={retryingAll}>
              {retryingAll ? "re-parsing…" : `re-parse incomplete (${unresolvedCount})`}
            </Btn>
          )}
          <Btn size="sm" onClick={() => { setAttachTargetId(null); setShowUpload((v) => !v); }}>+ upload statement</Btn>
        </>}>

        {/* Fetch from Gmail */}
        <div style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap", padding: 10, marginBottom: 10, border: "1px solid var(--edge)", borderRadius: 2 }}>
          <div style={{ minWidth: 220 }}>
            <label style={labelStyle}>fetch from mailbox</label>
            <HudSelect value={fetchAccountId} onChange={setFetchAccountId}
              placeholder={emailAccounts.length ? "select mailbox" : "no mailbox connected"}
              options={emailAccounts.map((a) => ({ value: a.id, label: a.email_address }))} />
          </div>
          <div style={{ minWidth: 140 }}>
            <label style={labelStyle}>period</label>
            <HudSelect value={fetchPeriodDays} onChange={setFetchPeriodDays} options={[
              { value: "7", label: "last 7 days" },
              { value: "30", label: "last 30 days" },
              { value: "90", label: "last 90 days" },
              { value: "180", label: "last 6 months" },
              { value: "365", label: "last 12 months" },
            ]} />
          </div>
          <Btn size="sm" variant="primary" disabled={fetching || !fetchAccountId} onClick={fetchFromGmail}>
            {fetching ? "fetching…" : "fetch statements"}
          </Btn>
          <div style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-hud)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
            statements auto-detect bank + type from the sender
          </div>
        </div>

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
          <Btn size="sm" variant={filterUnlinked ? "primary" : undefined} onClick={() => setFilterUnlinked((v) => !v)}>unlinked only</Btn>
          <div style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-hud)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
            {filtered.length} / {items.length}
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
          <div style={{ maxHeight: "min(58vh, 560px)", minHeight: 260, overflowY: "auto", overflowX: "auto", borderTop: "1px solid rgba(127,233,255,0.12)", borderBottom: "1px solid rgba(127,233,255,0.12)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead style={{ position: "sticky", top: 0, zIndex: 1, background: "var(--panel-tint-heavy)" }}>
             <tr style={{ color: "var(--text-dim)", textAlign: "left", fontSize: 10, fontFamily: "var(--font-hud)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>bank · card/account</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>subject / sender</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>date</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>period</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>txns</th>
               <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)" }}>status</th>
                <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--edge)", textAlign: "right" }}>PDF</th>
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
               return (
                 <Fragment key={s.id}>
                   <tr style={{ borderBottom: "1px solid rgba(127,233,255,0.06)", cursor: "pointer" }} onClick={() => toggleOpen(s)}>
                     <td style={{ padding: "6px 8px", verticalAlign: "top" }}>
                       <div style={{ color: "var(--text)", fontWeight: 500 }}>{bank ?? "Unknown bank"}</div>
                       <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
                         {entity ?? <span style={{ color: "var(--warn)" }}>unlinked</span>}
                         {" · "}<Chip>{s.statement_type}</Chip>
                       </div>
                        {unlinkedReason && <div style={{ color: "var(--warn)", fontSize: 10, marginTop: 2 }}>{unlinkedReason}</div>}
                     </td>
                     <td style={{ padding: "6px 8px", verticalAlign: "top", maxWidth: 380 }}>
                       <div style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={em?.subject ?? ""}>
                         {em?.subject ?? (s.source === "manual" ? "Manual upload" : "—")}
                       </div>
                       <div style={{ color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={em?.from_email ?? ""}>
                         {em?.from_name ? `${em.from_name} · ` : ""}{em?.from_email ?? ""}
                       </div>
                     </td>
                     <td style={{ padding: "6px 8px", color: "var(--text-dim)", verticalAlign: "top" }}>{dateStr}</td>
                     <td style={{ padding: "6px 8px", color: "var(--text-dim)", verticalAlign: "top" }}>{s.period_start && s.period_end ? `${s.period_start} → ${s.period_end}` : "—"}</td>
                     <td style={{ padding: "6px 8px", color: "var(--text-dim)", verticalAlign: "top" }}>{s.transactions_found ?? 0}</td>
                     <td style={{ padding: "6px 8px", verticalAlign: "top" }}>
                       <Chip tone={statusTone(s.parse_status)}>{s.parse_status ?? "manual"}</Chip>
                       {s.parse_reason && (
                         <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2, maxWidth: 220 }}>{s.parse_reason}</div>
                       )}
                        {needsReparse(s) && s.parse_status === "parsed" && (
                          <div style={{ fontSize: 10, color: "var(--warn)", marginTop: 2, maxWidth: 220 }}>parsed row is missing fields or transactions</div>
                        )}
                        {hint && s.parse_status !== "parsed" && (
                         <div style={{ fontSize: 10, color: "var(--warn)", marginTop: 2, maxWidth: 220 }}>{hint}</div>
                       )}
                     </td>
                      <td style={{ padding: "6px 8px", verticalAlign: "top", textAlign: "right" }}>
                        {s.file_path ? (
                          <Btn size="sm" onClick={(e: any) => { e.stopPropagation(); viewPdf(s); }}>view PDF</Btn>
                        ) : <span className="hud-label">—</span>}
                      </td>
                   </tr>
                   {openId === s.id && (
                     <tr>
                        <td colSpan={7} style={{ padding: "10px 8px", background: "rgba(53,214,237,0.03)", borderBottom: "1px solid rgba(127,233,255,0.06)" }}>
                         <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 11, color: "var(--text-dim)" }}>
                           <div><span className="hud-label">total due</span><br />{s.total_due != null ? inr(s.total_due) : "—"}</div>
                           <div><span className="hud-label">closing balance</span><br />{s.closing_balance != null ? inr(s.closing_balance) : "—"}</div>
                           <div><span className="hud-label">statement date</span><br />{s.statement_date ? new Date(s.statement_date).toLocaleDateString() : "—"}</div>
                           <div><span className="hud-label">due date</span><br />{s.due_date ? new Date(s.due_date).toLocaleDateString() : "—"}</div>
                            {s.file_path && <Btn size="sm" onClick={(e: any) => { e.stopPropagation(); viewPdf(s); }}>view PDF →</Btn>}
                           {s.parse_status === "parsed" && (
                             <Btn size="sm" disabled={summarizingId === s.id} onClick={() => summarize(s)}>
                               {summarizingId === s.id ? "summarizing…" : s.ai_summary ? "regenerate AI summary" : "AI summary"}
                             </Btn>
                           )}
                           {s.parse_status === "skipped" && (
                             <Btn size="sm" variant="primary" onClick={() => startAttachToRow(s)}>
                               attach PDF for this statement →
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
                         {hint && s.parse_status !== "parsed" && (
                           <div style={{ marginTop: 8, padding: "6px 8px", background: "rgba(255,107,107,0.08)", border: "1px solid rgba(255,107,107,0.25)", borderRadius: 4, color: "var(--warn)", fontSize: 11 }}>
                             <span className="hud-label" style={{ color: "var(--warn)" }}>{s.parse_error}</span> · {hint}
                           </div>
                         )}
                          {(s.parse_status === "failed" || s.parse_status === "pending" || needsReparse(s) || (!s.credit_card_id && !s.financial_account_id && !s.loan_id)) && (
                           <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "end", flexWrap: "wrap" }}>
                             <div style={{ minWidth: 240 }}>
                               <label style={labelStyle}>link to card / account</label>
                               <HudSelect value={retryLinkId} onChange={setRetryLinkId} placeholder="—" options={[
                                 ...cards.map((c: any) => ({ value: c.id, label: `${c.card_name} (card${c.banks?.name ? ` · ${c.banks.name}` : ""})` })),
                                 ...accounts.map((a: any) => ({ value: a.id, label: `${a.nickname} (account${a.banks?.name ? ` · ${a.banks.name}` : ""})` })),
                               ]} />
                             </div>
                             <div>
                               <label style={labelStyle}>password (optional)</label>
                               <input type="password" value={retryPassword} onChange={(e) => setRetryPassword(e.target.value)} placeholder="auto-try saved" style={{ ...inputStyle, width: 160 }} />
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
