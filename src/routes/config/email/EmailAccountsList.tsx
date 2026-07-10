import { useEffect, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { db, type EmailAccount } from "@/lib/db";
import { gmail, GmailApiError } from "@/lib/gmail";
import { useUi } from "@/store/uiStore";
import { Trash2, RefreshCw, Link2, Settings, X, Copy, AlertTriangle } from "lucide-react";
import AccountRulesDrawer from "./AccountRulesDrawer";

type ErrInfo = { message: string; status?: number; details?: string; hint?: string };
type GmailOAuthMessage = {
  type: "gmail-oauth-result";
  connected?: string | null;
  error?: string | null;
  aid?: string | null;
};

const OAUTH_POPUP_NAME = "jarvis_gmail_oauth";
const POPUP_FEATURES = "popup=yes,width=520,height=720,menubar=no,toolbar=no,location=yes,status=no,scrollbars=yes,resizable=yes";

function relTime(iso?: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function StatusChip({ a }: { a: EmailAccount }) {
  if ((a as any).paused_at) return <Chip tone="warn">paused</Chip>;
  if (a.provider !== "gmail") return <Chip>{a.provider ?? "—"}</Chip>;
  if (!a.connected_at) return <Chip tone="warn">not connected</Chip>;
  if (a.sync_status === "syncing") return <Chip tone="accent">syncing…</Chip>;
  if (a.sync_status === "error") return <Chip tone="warn">error</Chip>;
  if (a.last_synced_at) return <Chip tone="accent">synced {relTime(a.last_synced_at)}</Chip>;
  return <Chip tone="accent">connected</Chip>;
}

function ErrorPanel({ err, onRetry, onDismiss, retrying }: { err: ErrInfo; onRetry: () => void; onDismiss: () => void; retrying?: boolean }) {
  const copy = async () => {
    const blob = [
      `Gmail failed: ${err.message}`,
      err.status != null ? `HTTP ${err.status}` : "",
      err.hint ? `Hint: ${err.hint}` : "",
      err.details ? `Details: ${err.details}` : "",
    ].filter(Boolean).join("\n");
    try { await navigator.clipboard.writeText(blob); } catch {}
  };
  return (
    <div style={{
      marginTop: 6, padding: "10px 12px",
      border: "1px solid var(--warn, #e0a458)",
      background: "rgba(224,164,88,0.06)",
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <AlertTriangle size={14} style={{ color: "var(--warn, #e0a458)", marginTop: 2, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: "var(--text)", fontWeight: 600 }}>
            Gmail failed{err.status ? ` · ${err.status}` : ""}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim, var(--text))", marginTop: 2, wordBreak: "break-word" }}>
            {err.message}
          </div>
          {err.hint && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>→ {err.hint}</div>}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <Btn size="sm" onClick={copy}><Copy size={12} style={{ marginRight: 4 }} />copy</Btn>
        <Btn size="sm" onClick={onDismiss}><X size={12} style={{ marginRight: 4 }} />dismiss</Btn>
        <Btn size="sm" variant="primary" onClick={onRetry} disabled={retrying}>
          <RefreshCw size={12} style={{ marginRight: 4 }} />{retrying ? "retrying…" : "retry"}
        </Btn>
      </div>
    </div>
  );
}

function DeleteDialog({ account, onCancel, onConfirm }: { account: EmailAccount; onCancel: () => void; onConfirm: () => void }) {
  const [text, setText] = useState("");
  const ok = text.trim().toLowerCase() === account.email_address.toLowerCase();
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 110, display: "grid", placeItems: "center" }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(420px,90%)", padding: 16, background: "var(--bg, #0b1117)", border: "1px solid var(--edge-strong)", display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="hud-label" style={{ color: "var(--warn, #e0a458)" }}>delete mailbox</div>
        <div style={{ fontSize: 12, color: "var(--text)" }}>
          This removes the connection and stored tokens for <b>{account.email_address}</b>. Emails already synced remain in the database.
        </div>
        <div>
          <label style={labelStyle}>type the email to confirm</label>
          <input value={text} onChange={(e) => setText(e.target.value)} style={{ ...inputStyle, width: "100%" }} autoFocus />
        </div>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <Btn size="sm" onClick={onCancel}>cancel</Btn>
          <Btn size="sm" variant="danger" disabled={!ok} onClick={onConfirm}>delete</Btn>
        </div>
      </div>
    </div>
  );
}

export default function EmailAccountsList({ initialAddView = false }: { initialAddView?: boolean } = {}) {
  const [items, setItems] = useState<EmailAccount[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showAdd, setShowAdd] = useState(initialAddView);
  const [addr, setAddr] = useState("");
  const [purpose, setPurpose] = useState<EmailAccount["purpose"]>("other");
  const [provider, setProvider] = useState("gmail");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, ErrInfo>>({});
  const [globalErr, setGlobalErr] = useState<ErrInfo | null>(null);
  const [rulesFor, setRulesFor] = useState<EmailAccount | null>(null);
  const [deleteFor, setDeleteFor] = useState<EmailAccount | null>(null);
  const push = useUi((s) => s.push);

  const load = async () => {
    const list = await db.emailAccounts.list();
    setItems(list as EmailAccount[]);
    setLoaded(true);
  };
  useEffect(() => { load(); }, []);

  const applyOAuthResult = (result: GmailOAuthMessage) => {
    const connected = result.connected ?? null;
    const err = result.error ?? null;
    const aid = result.aid ?? null;
    if (connected) {
      push(`Connected ${connected}`, "ok");
      if (aid) setErrors((m) => { const c = { ...m }; delete c[aid]; return c; });
      if (aid) setBusyId((id) => (id === aid ? null : id));
      setGlobalErr(null);
      load();
    }
    if (err) {
      const info: ErrInfo = { message: err, hint: "Google returned this OAuth error." };
      push(`Gmail: ${err}`, "err");
      if (aid) setErrors((m) => ({ ...m, [aid]: info }));
      else setGlobalErr(info);
      if (aid) setBusyId((id) => (id === aid ? null : id));
    }
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent<GmailOAuthMessage>) => {
      const supabaseOrigin = new URL(import.meta.env.VITE_SUPABASE_URL).origin;
      if (event.origin !== window.location.origin && event.origin !== supabaseOrigin) return;
      if (event.data?.type !== "gmail-oauth-result") return;
      applyOAuthResult(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [push]);

  useEffect(() => {
    const u = new URL(window.location.href);
    const connected = u.searchParams.get("connected");
    const err = u.searchParams.get("gmail_error");
    const aid = u.searchParams.get("aid");
    if (connected || err) applyOAuthResult({ type: "gmail-oauth-result", connected, error: err, aid });
    if ((connected || err) && window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage({ type: "gmail-oauth-result", connected, error: err, aid }, window.location.origin);
        window.close();
      } catch {}
    }
    if (connected || err) {
      u.searchParams.delete("connected"); u.searchParams.delete("gmail_error"); u.searchParams.delete("aid");
      window.history.replaceState(null, "", u.pathname + (u.search || ""));
      load();
    }
  }, [push]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addr.trim()) return;
    try {
      await db.emailAccounts.create({ email_address: addr.trim(), purpose, provider });
      setAddr(""); setShowAdd(false); load();
    } catch (err: any) { push(err?.message, "err"); }
  };

  const toErrInfo = (e: any): ErrInfo => {
    if (e instanceof GmailApiError) return { message: e.message, status: e.status, details: e.details, hint: e.hint };
    return { message: e?.message ?? String(e) };
  };

  const connect = async (a: EmailAccount) => {
    setBusyId(a.id);
    setErrors((m) => { const c = { ...m }; delete c[a.id]; return c; });
    const popup = window.open("about:blank", OAUTH_POPUP_NAME, POPUP_FEATURES);
    if (popup) {
      popup.document.title = "Connecting Gmail…";
      popup.document.body.style.cssText = "margin:0;background:#0b1117;color:#d7f7ff;font:14px system-ui;display:grid;place-items:center;height:100vh";
      popup.document.body.textContent = "Connecting Gmail…";
      const timer = window.setInterval(() => {
        if (popup.closed) { window.clearInterval(timer); setBusyId((id) => (id === a.id ? null : id)); }
      }, 1000);
    }
    try {
      const { url } = await gmail.startOAuth(a.id);
      if (popup && !popup.closed) popup.location.href = url;
      else window.open(url, "_blank", POPUP_FEATURES) || window.location.assign(url);
    } catch (e: any) {
      if (popup && !popup.closed) popup.close();
      const info = toErrInfo(e);
      push(info.message ?? "connect failed", "err");
      setErrors((m) => ({ ...m, [a.id]: info }));
      setBusyId(null);
    }
  };

  const sync = async (a: EmailAccount) => {
    setBusyId(a.id);
    try {
      const r: any = await gmail.sync(a.id);
      if (r?.paused) push("account is paused — resume from rules to sync", "warn" as any);
      else push(`Synced ${r.inserted} new / ${r.total} scanned`, "ok");
      setErrors((m) => { const c = { ...m }; delete c[a.id]; return c; });
      load();
    } catch (e: any) {
      const info = toErrInfo(e);
      push(info.message ?? "sync failed", "err");
      setErrors((m) => ({ ...m, [a.id]: info }));
    } finally { setBusyId(null); }
  };

  const doDelete = async (a: EmailAccount) => {
    try { await db.emailAccounts.remove(a.id); push(`Deleted ${a.email_address}`, "ok"); setDeleteFor(null); load(); }
    catch (e: any) { push(e?.message ?? "delete failed", "err"); }
  };

  const dismiss = (id: string) => setErrors((m) => { const c = { ...m }; delete c[id]; return c; });

  return (
    <HudPanel
      title="Mailboxes"
      index="MAIL"
      live="ok"
      bodyClass="overflow-auto"
      actions={
        <Btn size="sm" variant="primary" onClick={() => setShowAdd((v) => !v)}>{showAdd ? "close" : "+ new mailbox"}</Btn>
      }
    >
      {showAdd && (
        <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr auto", gap: 8, alignItems: "end", marginBottom: 12, padding: 10, border: "1px solid var(--edge)" }}>
          <div><label style={labelStyle}>address</label><input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="name@example.com" style={{ ...inputStyle, width: "100%" }} autoFocus /></div>
          <div><label style={labelStyle}>purpose</label>
            <select value={purpose} onChange={(e) => setPurpose(e.target.value as EmailAccount["purpose"])} style={inputStyle}>
              <option value="work">work</option><option value="finance">finance</option><option value="personal">personal</option><option value="other">other</option>
            </select>
          </div>
          <div><label style={labelStyle}>provider</label>
            <select value={provider} onChange={(e) => setProvider(e.target.value)} style={inputStyle}>
              <option value="gmail">gmail</option><option value="outlook">outlook</option><option value="imap">imap</option><option value="other">other</option>
            </select>
          </div>
          <Btn type="submit" variant="primary" disabled={!addr.trim()}>+ add</Btn>
        </form>
      )}

      {globalErr && <div style={{ marginBottom: 10 }}><ErrorPanel err={globalErr} onRetry={() => setGlobalErr(null)} onDismiss={() => setGlobalErr(null)} /></div>}

      {loaded && items.length === 0 ? <EmptyState>no mailboxes yet — use “+ new mailbox”</EmptyState> :
       <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
         {items.map((a) => (
           <div key={a.id} style={{ display: "flex", flexDirection: "column", gap: 0 }}>
             <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: "1px solid var(--edge)", flexWrap: "wrap" }}>
               <div style={{ fontSize: 12, color: "var(--text)", flex: 1, minWidth: 200 }}>
                 {a.email_address}
                 {a.last_error && <div style={{ fontSize: 10, color: "var(--warn, #e0a458)", marginTop: 2 }}>{a.last_error}</div>}
               </div>
               <Chip tone={a.purpose === "finance" ? "accent" : "neutral"}>{a.purpose}</Chip>
               <StatusChip a={a} />
               {a.provider === "gmail" && !a.connected_at && (
                 <Btn size="sm" variant="primary" onClick={() => connect(a)} disabled={busyId === a.id}>
                   <Link2 size={12} style={{ marginRight: 4 }} />{busyId === a.id ? "connecting…" : "connect"}
                 </Btn>
               )}
               {a.provider === "gmail" && a.connected_at && (
                 <>
                   <Btn size="sm" onClick={() => sync(a)} disabled={busyId === a.id}><RefreshCw size={12} style={{ marginRight: 4 }} />sync</Btn>
                   <Btn size="sm" onClick={() => connect(a)} disabled={busyId === a.id}>reconnect</Btn>
                 </>
               )}
               <Btn size="sm" onClick={() => setRulesFor(a)}><Settings size={12} style={{ marginRight: 4 }} />rules</Btn>
               <button
                 aria-label={`delete ${a.email_address}`}
                 style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
                 onClick={() => setDeleteFor(a)}
               ><Trash2 size={13} /></button>
             </div>
             {errors[a.id] && (
               <ErrorPanel err={errors[a.id]} retrying={busyId === a.id} onRetry={() => connect(a)} onDismiss={() => dismiss(a.id)} />
             )}
           </div>
         ))}
       </div>}

      {rulesFor && (
        <AccountRulesDrawer
          account={rulesFor}
          onClose={() => setRulesFor(null)}
          onSaved={(updated) => {
            setItems((list) => list.map((x) => (x.id === updated.id ? updated : x)));
            setRulesFor(updated);
          }}
        />
      )}
      {deleteFor && <DeleteDialog account={deleteFor} onCancel={() => setDeleteFor(null)} onConfirm={() => doDelete(deleteFor)} />}
    </HudPanel>
  );
}