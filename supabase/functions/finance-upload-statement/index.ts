// Manually upload a bank/card statement PDF — closes the gap where a
// statement never arrives by email (no Gmail account connected, or the bank
// just doesn't email statements). Same parse pipeline as the Gmail path,
// just skipping the "find it in an inbox" step.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { parseStatementPdfWithPasswords } from "../_shared/statement-pdf.ts";
import { applyParsedStatementResult, loadPasswordCandidates, saveWinningPassword } from "../_shared/finance-extract-core.ts";
import { decryptStatementPassword, type StatementPasswordRule } from "../_shared/crypto.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";

const STATEMENT_BUCKET = "statement-pdfs";
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — statements are bigger than the 8MB image cap elsewhere
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const uploadLimiter = createSlidingWindowLimiter(10, 60_000);

function safeName(filename: string): string {
  return filename.replace(/[^\w.\-]/g, "_").slice(0, 80);
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

  const rl = uploadLimiter.check(uid);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }), {
      status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
    });
  }

  try {
    const { statement_type, credit_card_id, financial_account_id, loan_id, filename, contentType, bytesBase64, password, existing_statement_id } = await req.json();
    if (!statement_type || !filename || !bytesBase64) {
      return new Response(JSON.stringify({ error: "statement_type, filename, bytesBase64 required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (!contentType || contentType !== "application/pdf") {
      return new Response(JSON.stringify({ error: "contentType must be application/pdf" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    // Reject oversized payloads before fully decoding — base64 length is a
    // safe upper-bound estimate of decoded size (actual is ~3/4 of this).
    if (bytesBase64.length > MAX_BYTES * 1.4) {
      return new Response(JSON.stringify({ error: `file too large (max ${MAX_BYTES} bytes)` }), {
        status: 413, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(url, svc, { auth: { persistSession: false } });

    // Verify ownership of whatever entity this statement is being linked to,
    // and fetch its stored password if present.
    let passwordRule: StatementPasswordRule | null = null;
    if (credit_card_id) {
      const { data } = await supabase.from("credit_cards").select("id, statement_password_rule").eq("id", credit_card_id).eq("user_id", uid).maybeSingle();
      if (!data) return new Response(JSON.stringify({ error: "card not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
      passwordRule = data.statement_password_rule ?? null;
    } else if (financial_account_id) {
      const { data } = await supabase.from("financial_accounts").select("id, statement_password_rule").eq("id", financial_account_id).eq("user_id", uid).maybeSingle();
      if (!data) return new Response(JSON.stringify({ error: "account not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
      passwordRule = data.statement_password_rule ?? null;
    } else if (loan_id) {
      const { data } = await supabase.from("loans").select("id").eq("id", loan_id).eq("user_id", uid).maybeSingle();
      if (!data) return new Response(JSON.stringify({ error: "loan not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
    }

    // decode base64 -> bytes
    const binary = atob(bytesBase64);
    if (binary.length > MAX_BYTES) {
      return new Response(JSON.stringify({ error: `file too large (max ${MAX_BYTES} bytes)` }), {
        status: 413, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // Magic-byte check — contentType/filename are caller-supplied and easy to
    // spoof; verify the actual bytes look like a PDF before hashing/inserting
    // a row for them.
    if (!PDF_MAGIC.every((b, i) => bytes[i] === b)) {
      return new Response(JSON.stringify({ error: "file does not appear to be a valid PDF" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Content-hash dedupe (skip when we're intentionally attaching to an
    // existing skipped/pending statement row — that row IS the target).
    let contentHash: string | null = null;
    if (!existing_statement_id) {
      const hashBuf = await crypto.subtle.digest("SHA-256", bytes);
      contentHash = Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      const { data: dup } = await supabase.from("statements")
        .select("id, parse_status").eq("user_id", uid).eq("content_sha256", contentHash).maybeSingle();
      if (dup) {
        return new Response(JSON.stringify({
          ok: true, statement_id: dup.id, parse_status: dup.parse_status, duplicate: true,
        }), { headers: { ...cors, "Content-Type": "application/json" } });
      }
    }

    // Either target an existing statement row (attaching a PDF to a skipped
    // one) or create a new one for a truly manual upload.
    let statement: { id: string };
    if (existing_statement_id) {
      const { data: existing, error: exErr } = await supabase.from("statements")
        .select("id, user_id").eq("id", existing_statement_id).eq("user_id", uid).maybeSingle();
      if (exErr) throw exErr;
      if (!existing) return new Response(JSON.stringify({ error: "statement not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
      statement = { id: existing.id };
      await supabase.from("statements").update({
        parse_status: "pending", parse_error: null,
        credit_card_id: credit_card_id ?? null,
        financial_account_id: financial_account_id ?? null,
        loan_id: loan_id ?? null,
      }).eq("id", existing_statement_id);
    } else {
      const { data: created, error: stErr } = await supabase.from("statements").insert({
        user_id: uid,
        statement_type,
        credit_card_id: credit_card_id ?? null,
        financial_account_id: financial_account_id ?? null,
        loan_id: loan_id ?? null,
        source: "manual",
        parse_status: "pending",
        content_sha256: contentHash,
      }).select("id").single();
      if (stErr) throw stErr;
      statement = created;
    }

    const storagePath = `${uid}/manual/${statement.id}-${safeName(filename)}`;
    const { error: upErr } = await supabase.storage.from(STATEMENT_BUCKET).upload(storagePath, bytes, {
      contentType: "application/pdf",
      upsert: !!existing_statement_id, // attach-to-existing may retry
    });
    if (upErr) throw upErr;

    // Password rotation: explicit override → saved rule on linked entity →
    // user's default candidate list from jarvis_memory → no password.
    let savedPwd: string | undefined;
    if (passwordRule) {
      try { savedPwd = await decryptStatementPassword(passwordRule); }
      catch (e) { console.error("decryptStatementPassword failed", e instanceof Error ? e.message : e); }
    }
    const candidates = await loadPasswordCandidates(supabase, uid);
    const ordered = [password, savedPwd, ...candidates].filter((x): x is string => typeof x === "string" && x.length > 0);
    const rotation = await parseStatementPdfWithPasswords(bytes, ordered, {
      statement_type: (statement_type as any) ?? null,
    });
    const links = {
      credit_card_id: credit_card_id ?? null,
      financial_account_id: financial_account_id ?? null,
      loan_id: loan_id ?? null,
    };
    if (rotation.result.ok && rotation.winning_password && !savedPwd) {
      await saveWinningPassword(supabase, links, rotation.winning_password);
    }
    await applyParsedStatementResult(supabase, statement.id, uid, links, rotation.result, storagePath);

    const { data: updated } = await supabase.from("statements")
      .select("parse_status, parse_error").eq("id", statement.id).maybeSingle();

    return new Response(JSON.stringify({
      ok: true,
      statement_id: statement.id,
      parse_status: updated?.parse_status ?? null,
      parse_error: updated?.parse_error ?? null,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return sanitizedErrorResponse(err, "Statement upload failed", "finance-upload-statement", cors);
  }
});
