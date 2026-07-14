// Manually upload a bank/card statement PDF — closes the gap where a
// statement never arrives by email (no Gmail account connected, or the bank
// just doesn't email statements). Same parse pipeline as the Gmail path,
// just skipping the "find it in an inbox" step.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { parseStatementPdf } from "../_shared/statement-pdf.ts";
import { applyParsedStatementResult } from "../_shared/finance-extract-core.ts";
import { decryptStatementPassword, type StatementPasswordRule } from "../_shared/crypto.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { createSlidingWindowLimiter } from "../_shared/rate-limit.ts";
import { z } from "npm:zod";

const uploadLimiter = createSlidingWindowLimiter(6, 60_000);
const Body = z.object({
  statement_type: z.enum(["card", "account", "loan"]),
  credit_card_id: z.string().uuid().nullable().optional(),
  financial_account_id: z.string().uuid().nullable().optional(),
  loan_id: z.string().uuid().nullable().optional(),
  filename: z.string().min(1).max(255),
  contentType: z.literal("application/pdf"),
  bytesBase64: z.string().min(1),
  password: z.string().max(256).optional(),
});

const STATEMENT_BUCKET = "statement-pdfs";
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — statements are bigger than the 8MB image cap elsewhere

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
  if (!rl.ok) return new Response(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfter }), {
    status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
  });

  try {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return new Response(JSON.stringify({ error: "invalid_input", details: parsed.error.flatten() }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const { statement_type, credit_card_id, financial_account_id, loan_id, filename, bytesBase64, password } = parsed.data;
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

    // Magic-byte check: first 5 bytes must be "%PDF-". Prevents a caller
    // from sending arbitrary bytes with a PDF filename + MIME.
    if (bytes.length < 5 ||
      bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 ||
      bytes[3] !== 0x46 || bytes[4] !== 0x2d) {
      return new Response(JSON.stringify({ error: "not a PDF file" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Content-hash dedupe: the same PDF re-uploaded should return the
    // existing statement row instead of silently creating a duplicate that
    // would then re-parse and re-insert every transaction.
    const hashBuf = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const { data: dup } = await supabase.from("statements")
      .select("id, parse_status").eq("user_id", uid).eq("content_sha256", sha256).maybeSingle();
    if (dup) {
      return new Response(JSON.stringify({
        ok: true, statement_id: dup.id, parse_status: dup.parse_status, duplicate: true,
      }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    const { data: statement, error: stErr } = await supabase.from("statements").insert({
      user_id: uid,
      statement_type,
      credit_card_id: credit_card_id ?? null,
      financial_account_id: financial_account_id ?? null,
      loan_id: loan_id ?? null,
      source: "manual",
      parse_status: "pending",
      content_sha256: sha256,
    }).select("id").single();
    if (stErr) throw stErr;

    // Timestamp + statement id in the path so a repeat filename can never
    // silently overwrite an earlier upload. Bucket is per-user private.
    const storagePath = `${uid}/manual/${statement.id}-${Date.now()}-${safeName(filename)}`;
    const { error: upErr } = await supabase.storage.from(STATEMENT_BUCKET).upload(storagePath, bytes, {
      contentType: "application/pdf",
      upsert: false,
    });
    if (upErr) throw upErr;

    // Explicit user-supplied password wins; otherwise fall back to whatever
    // is stored against the linked card/account.
    let plaintextPassword: string | undefined = password || undefined;
    let decryptFailed = false;
    if (!plaintextPassword && passwordRule) {
      try { plaintextPassword = await decryptStatementPassword(passwordRule); }
      catch (e) {
        // B3 — surface a distinct parse_error so the UI can prompt the user
        // to re-enter their statement password instead of showing a generic
        // "wrong password" for what is actually a broken stored rule.
        console.error("decryptStatementPassword failed", e instanceof Error ? e.message : e);
        decryptFailed = true;
      }
    }

    if (decryptFailed) {
      await supabase.from("statements").update({
        parse_status: "failed",
        parse_error: "stored_password_unreadable",
      }).eq("id", statement.id);
      return new Response(JSON.stringify({
        ok: false,
        statement_id: statement.id,
        parse_status: "failed",
        parse_error: "stored_password_unreadable",
      }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }


    const result = await parseStatementPdf(bytes, plaintextPassword);
    await applyParsedStatementResult(supabase, statement.id, uid, {
      credit_card_id: credit_card_id ?? null,
      financial_account_id: financial_account_id ?? null,
      loan_id: loan_id ?? null,
    }, result, storagePath);

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
