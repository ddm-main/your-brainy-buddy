// Save user-supplied corrections for a statement AND learn from them:
//   1. Persist the values on the row (manual_override=true).
//   2. Download the PDF text, reverse-search for each corrected value,
//      derive the nearest label, and upsert those anchors into
//      `statement_skeletons` for this bank + statement_type + layout.
//   3. Kick off retries for sibling pending/failed statements so the newly
//      learned skeleton auto-fills them without more manual work.

import { createClient } from "npm:@supabase/supabase-js@2";
import { getDocument } from "npm:pdfjs-dist@4/legacy/build/pdf.mjs";
import { corsFor, preflight } from "../_shared/cors.ts";
import { requireUserId } from "../_shared/auth.ts";
import { sanitizedErrorResponse } from "../_shared/errors.ts";
import { extractPdfText } from "../_shared/statement-pdf.ts";
import {
  layoutFingerprint,
  learnAnchorsFromValues,
  mergeLearnedAnchors,
  upsertSkeleton,
  type SkeletonJson,
} from "../_shared/statement-skeleton.ts";
import { decryptStatementPassword, type StatementPasswordRule } from "../_shared/crypto.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BUCKET = "statement-pdfs";
const SIBLING_RETRY_CAP = 10;

const NUMBER_KEYS = new Set([
  "total_due", "min_due", "closing_balance", "credit_limit", "paid_amount",
]);
const DATE_KEYS = new Set([
  "statement_date", "due_date", "period_start", "period_end", "paid_on",
]);
const STRING_KEYS = new Set([
  "card_last4",
]);
const ALL_KEYS = new Set([...NUMBER_KEYS, ...DATE_KEYS, ...STRING_KEYS]);

// Normalize a user-entered card_last4 like "XX62", "xx 62", "**62", "62",
// "662", or "6662" into the trailing digits only. Returns null if fewer
// than 2 digits are present or more than 4 (nothing plausibly a last-4).
function normalizeLast4(input: string): string | null {
  const digits = String(input ?? "").replace(/\D+/g, "");
  if (digits.length < 2 || digits.length > 4) return null;
  return digits;
}

function validate(input: Record<string, unknown>): { ok: true; clean: Record<string, unknown> } | { ok: false; error: string } {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!ALL_KEYS.has(k)) continue;
    if (v === null || v === "" || v === undefined) { clean[k] = null; continue; }
    if (NUMBER_KEYS.has(k)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1e12) return { ok: false, error: `bad ${k}` };
      clean[k] = n;
    } else if (DATE_KEYS.has(k)) {
      const s = String(v).slice(0, 10);
      if (!ISO_DATE.test(s)) return { ok: false, error: `bad ${k}` };
      clean[k] = s;
    } else if (STRING_KEYS.has(k)) {
      const s = String(v).trim();
      if (k === "card_last4") {
        const norm = normalizeLast4(s);
        if (!norm) return { ok: false, error: "card_last4 must include 2–4 visible digits (e.g. 62, XX62, or 6662)" };
        clean[k] = norm;
      } else {
        clean[k] = s;
      }
    }
  }
  return { ok: true, clean };
}

// Same password rotation used elsewhere.
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

async function fetchSavedPassword(svc: any, uid: string, s: { credit_card_id: string | null; financial_account_id: string | null }): Promise<string | null> {
  const table = s.credit_card_id ? "credit_cards" : s.financial_account_id ? "financial_accounts" : null;
  const id = s.credit_card_id ?? s.financial_account_id ?? null;
  if (!table || !id) return null;
  const { data } = await svc.from(table).select("statement_password_rule").eq("user_id", uid).eq("id", id).maybeSingle();
  const rule = data?.statement_password_rule as StatementPasswordRule | null | undefined;
  if (!rule) return null;
  try { return await decryptStatementPassword(rule); } catch { return null; }
}

async function detectPdfPassword(bytes: Uint8Array, candidates: (string | null)[]): Promise<string | null | "failed"> {
  try {
    const doc = await getDocument({ data: bytes, disableWorker: true } as any).promise;
    await doc.getPage(1);
    await doc.destroy().catch(() => {});
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/password/i.test(msg)) return "failed";
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
      if (!/password/i.test(msg)) return "failed";
    }
  }
  return "failed";
}

async function tryExtractText(svc: any, uid: string, statement: any): Promise<string | null> {
  if (!statement?.file_path) return null;
  try {
    const { data: blob, error } = await svc.storage.from(BUCKET).download(statement.file_path);
    if (error || !blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const saved = await fetchSavedPassword(svc, uid, statement);
    const candidates = [saved, ...(await loadPasswordCandidates(svc, uid))];
    const pwd = await detectPdfPassword(bytes, candidates);
    if (pwd === "failed") return null;
    const res = await extractPdfText(bytes, pwd ?? undefined);
    return res.ok ? res.text : null;
  } catch {
    return null;
  }
}

async function enqueueSiblingRetries(
  req: Request,
  svc: any,
  uid: string,
  statement: any,
): Promise<number> {
  const { data: siblings } = await svc.from("statements")
    .select("id")
    .eq("user_id", uid)
    .eq("bank_slug", statement.bank_slug)
    .eq("statement_type", statement.statement_type)
    .neq("id", statement.id)
    .in("parse_status", ["pending", "failed", "needs_review"])
    .limit(SIBLING_RETRY_CAP);
  if (!siblings?.length) return 0;

  const url = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  let ok = 0;
  await Promise.all(siblings.slice(0, SIBLING_RETRY_CAP).map(async (s: any) => {
    try {
      const r = await fetch(`${url}/functions/v1/finance-retry-statement`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ statement_id: s.id }),
      });
      if (r.ok) ok++;
    } catch { /* ignore */ }
  }));
  return ok;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsFor(req);

  const auth = await requireUserId(req);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: "unauthorized" }),
      { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
  }
  const uid = auth.userId;

  try {
    const body = await req.json().catch(() => ({}));
    const statement_id = body?.statement_id as string | undefined;
    const fields = (body?.fields ?? {}) as Record<string, unknown>;
    if (!statement_id) {
      return new Response(JSON.stringify({ error: "statement_id required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const v = validate(fields);
    if (!v.ok) {
      return new Response(JSON.stringify({ error: v.error }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(url, svc, { auth: { persistSession: false } });

    const { data: existing, error: findErr } = await supabase.from("statements")
      .select("id, user_id, manual_fields, bank_slug, statement_type, credit_card_id, financial_account_id, file_path")
      .eq("id", statement_id).maybeSingle();
    if (findErr) throw findErr;
    if (!existing || existing.user_id !== uid) {
      return new Response(JSON.stringify({ error: "not found" }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
    }

    // `card_last4` is not a column on `statements` — the last-4 lives on
    // `credit_cards.masked_number`. Pull it out of the writable set, and if
    // supplied, try to link the statement to the matching credit card.
    const suppliedLast4 = typeof v.clean.card_last4 === "string" ? (v.clean.card_last4 as string) : null;
    delete v.clean.card_last4;

    // Suffix match — the user may only see 2 digits (e.g. SBI shows `XX62`
    // for card 6662). A saved card matches when its digits-only masked_number
    // ends with the supplied reveal. If more than one card matches, prefer
    // one whose bank matches the statement's bank_slug; otherwise leave the
    // link unresolved and report ambiguity to the caller.
    let linkedCardId: string | null = null;
    let ambiguousLast4 = false;
    if (suppliedLast4) {
      const { data: cards } = await supabase.from("credit_cards")
        .select("id, masked_number, bank_id, banks(name)").eq("user_id", uid);
      const matches = (cards ?? []).filter((c: any) => {
        const digits = String(c.masked_number ?? "").replace(/\D+/g, "");
        return digits.length >= suppliedLast4.length && digits.endsWith(suppliedLast4);
      });
      if (matches.length === 1) {
        linkedCardId = matches[0].id;
      } else if (matches.length > 1) {
        const bankSlug = (existing.bank_slug ?? "").toString().toLowerCase();
        const bankMatch = matches.find((c: any) => {
          const n = String(c.banks?.name ?? "").toLowerCase().replace(/\s+/g, "");
          return bankSlug && n.includes(bankSlug.replace(/-/g, ""));
        });
        if (bankMatch) linkedCardId = bankMatch.id;
        else ambiguousLast4 = true;
      }
    }

    const mergedManual = {
      ...(existing.manual_fields as Record<string, unknown> ?? {}),
      ...v.clean,
      ...(suppliedLast4 ? { card_last4: suppliedLast4 } : {}),
    };

    const update: Record<string, unknown> = {
      ...v.clean,
      manual_override: true,
      manual_override_at: new Date().toISOString(),
      manual_fields: mergedManual,
      parse_status: "parsed",
      parse_error: null,
      parse_reason: "manual_override",
      ...(linkedCardId ? { credit_card_id: linkedCardId } : {}),
    };

    const { error: upErr } = await supabase.from("statements")
      .update(update).eq("id", statement_id).eq("user_id", uid);
    if (upErr) throw upErr;

    // If this statement is already linked but the card has no usable mask,
    // preserve the user's last-4 there too. Never overwrite a fuller mask
    // that already ends with the supplied digits.
    const targetCardId = linkedCardId ?? existing.credit_card_id ?? null;
    if (suppliedLast4 && targetCardId) {
      const { data: card } = await supabase.from("credit_cards")
        .select("masked_number").eq("id", targetCardId).eq("user_id", uid).maybeSingle();
      const currentDigits = String(card?.masked_number ?? "").replace(/\D+/g, "");
      if (!currentDigits || !currentDigits.endsWith(suppliedLast4)) {
        await supabase.from("credit_cards")
          .update({ masked_number: suppliedLast4 })
          .eq("id", targetCardId).eq("user_id", uid);
      }
    }

    // --- Learn: turn the correction into skeleton anchors ---
    let learned_fields: string[] = [];
    let siblings_auto_parsed = 0;
    let skipped_learn: Array<{ key: string; reason: string }> = [];

    if (existing.bank_slug && existing.statement_type && existing.file_path) {
      const text = await tryExtractText(supabase, uid, existing);
      if (text) {
        const fp = await layoutFingerprint(text);
        const learnInput = {
          statement_date: (v.clean.statement_date as string) ?? null,
          due_date:       (v.clean.due_date as string)       ?? null,
          period_start:   (v.clean.period_start as string)   ?? null,
          period_end:     (v.clean.period_end as string)     ?? null,
          total_due:       (v.clean.total_due as number)        ?? null,
          min_due:         (v.clean.min_due as number)          ?? null,
          closing_balance: (v.clean.closing_balance as number)  ?? null,
          credit_limit:    (v.clean.credit_limit as number)     ?? null,
        };
        const learnResult = learnAnchorsFromValues(
          text,
          existing.statement_type as "card" | "account" | "loan",
          learnInput,
        );
        learned_fields = learnResult.learned_keys.map(String);
        skipped_learn = learnResult.skipped.map((s) => ({ key: String(s.key), reason: s.reason }));

        if (learned_fields.length > 0) {
          // Load any existing skeleton for this exact layout to merge into.
          const { data: existingSkel } = await supabase.from("statement_skeletons")
            .select("skeleton")
            .eq("user_id", uid)
            .eq("bank_slug", existing.bank_slug)
            .eq("statement_type", existing.statement_type)
            .eq("layout_fingerprint", fp)
            .maybeSingle();

          const merged: SkeletonJson = mergeLearnedAnchors(
            (existingSkel?.skeleton as SkeletonJson | null) ?? null,
            existing.bank_slug as string,
            existing.statement_type as "card" | "account" | "loan",
            learnResult.fields,
          );

          await upsertSkeleton(supabase, uid, {
            bank_slug: existing.bank_slug as string,
            statement_type: existing.statement_type as "card" | "account" | "loan",
            variant: merged.variant ?? null,
            layout_fingerprint: fp,
            skeleton: merged,
            sample_statement_id: existing.id,
          }).catch(() => null);

          // Fan out retries so the new anchors auto-fill sibling statements.
          siblings_auto_parsed = await enqueueSiblingRetries(req, supabase, uid, existing);
        }
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      updated: Object.keys(v.clean),
      linked_card_id: targetCardId,
      learned_fields,
      skipped_learn,
      siblings_auto_parsed,
      ambiguous_last4: ambiguousLast4,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return sanitizedErrorResponse(err, "Could not save manual fields", "finance-statement-manual-fields", cors);
  }
});
