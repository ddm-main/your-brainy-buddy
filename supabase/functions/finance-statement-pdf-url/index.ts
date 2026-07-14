// Issues a short-lived signed URL for a statement PDF. If the PDF is
// password-protected, we detect the linked card/account password server-side
// and return it only to the authenticated statement owner so the in-app PDF.js
// renderer can open the document without prompting.

// deno-lint-ignore no-explicit-any
import { getDocument } from "npm:pdfjs-dist@4/legacy/build/pdf.mjs";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { decryptStatementPassword, type StatementPasswordRule } from "../_shared/crypto.ts";

async function loadPasswordCandidates(svc: any, userId: string): Promise<string[]> {
  try {
    const { data } = await svc.from("jarvis_memory")
      .select("content").eq("user_id", userId).eq("topic", "finance.statement_password_candidates").maybeSingle();
    if (!data?.content) return [];
    const parsed = JSON.parse(data.content);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x: unknown): x is string => typeof x === "string" && x.length > 0);
  } catch { return []; }
}

const BUCKET = "statement-pdfs";
const EXPIRY_SECONDS = 300;

async function fetchSavedPassword(svc: any, uid: string, s: { credit_card_id: string | null; financial_account_id: string | null }): Promise<string | null> {
  const table = s.credit_card_id ? "credit_cards" : s.financial_account_id ? "financial_accounts" : null;
  const id = s.credit_card_id ?? s.financial_account_id ?? null;
  if (!table || !id) return null;
  const { data } = await svc.from(table).select("statement_password_rule").eq("user_id", uid).eq("id", id).maybeSingle();
  const rule = data?.statement_password_rule as StatementPasswordRule | null | undefined;
  if (!rule) return null;
  try { return await decryptStatementPassword(rule); } catch { return null; }
}

// Try passwords in order until one opens the PDF. PDF.js can render encrypted
// PDFs when supplied the password; serializing a truly unlocked PDF from the
// edge runtime is unreliable, so the frontend receives this password for the
// current authenticated view instead.
async function detectPdfPassword(bytes: Uint8Array, candidates: (string | null)[]): Promise<string | null | "failed"> {
  // Probe unprotected first.
  try {
    const doc = await getDocument({ data: bytes, disableWorker: true } as any).promise;
    await doc.getPage(1);
    await doc.destroy().catch(() => {});
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/password/i.test(msg)) throw e;
  }
  const seen = new Set<string>();
  for (const pwd of candidates) {
    if (!pwd || seen.has(pwd)) continue;
    seen.add(pwd);
    try {
      const doc = await getDocument({ data: bytes, password: pwd, disableWorker: true } as any).promise;
      await doc.getPage(1);
      await doc.destroy().catch(() => {});
      return pwd;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/password/i.test(msg)) throw e;
    }
  }
  return "failed";
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);

  const auth = await requireUserId(req);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const uid = auth.userId;

  try {
    const { statement_id } = await req.json();
    if (!statement_id) {
      return new Response(JSON.stringify({ error: "statement_id required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(url, svc, { auth: { persistSession: false } });

    const { data: statement, error: findErr } = await supabase
      .from("statements")
      .select("id, user_id, file_path, credit_card_id, financial_account_id")
      .eq("id", statement_id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!statement || statement.user_id !== uid || !statement.file_path) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Download original bytes.
    const { data: blob, error: dlErr } = await supabase.storage.from(BUCKET).download(statement.file_path);
    if (dlErr || !blob) throw dlErr ?? new Error("download failed");
    const bytes = new Uint8Array(await blob.arrayBuffer());

    // Try decryption with all known passwords.
    const saved = await fetchSavedPassword(supabase, uid, statement);
    const candidates = [saved, ...(await loadPasswordCandidates(supabase, uid))];
    const viewerPassword = await detectPdfPassword(bytes, candidates);

    if (viewerPassword === "failed") {
      return new Response(JSON.stringify({ error: "password_required", message: "Save the PDF password on this card/account, then retry." }), {
        status: 409, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const { data: signed, error: signErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(statement.file_path, EXPIRY_SECONDS);
    if (signErr) throw signErr;

    return new Response(JSON.stringify({
      url: signed.signedUrl,
      password_protected: viewerPassword !== null,
      viewer_password: viewerPassword,
    }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return sanitizedErrorResponse(err, "Could not open that statement", "finance-statement-pdf-url", cors);
  }
});
