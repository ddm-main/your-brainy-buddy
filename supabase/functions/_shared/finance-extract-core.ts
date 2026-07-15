// Turn stored finance emails into structured records: transactions,
// statements, EMIs, investments — auto-linked to a card / account / loan when
// possible. Idempotent: safe to re-run on the same email set.
//
// Statement emails additionally get their PDF attachment (if any) downloaded,
// stored in the private statement-pdfs bucket, decrypted with the linked
// card/account's stored password, and parsed for real period/due/balance and
// itemized transaction data — see statement-pdf.ts.

import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ensureAccessToken, extractBody, gapi, listAttachments, downloadAttachment } from "./gmail.ts";
import { isFinanceMail, isFinanceSender, parseFinanceEmail, guessBankSlugFromSender, unwrapForwarded, type Parsed } from "./finance-parsers.ts";
import { parseStatementPdfWithPasswords } from "./statement-pdf.ts";
import { decryptStatementPassword, encryptStatementPassword, type StatementPasswordRule } from "./crypto.ts";
import {
  applySkeleton,
  layoutFingerprint,
  learnAndParse,
  learnSkeleton,
  loadSkeleton,
  loadSkeletonByStructure,
  recordSkeletonOutcome,
  structuralFingerprint,
  synthesizeSkeletonFromResult,
  upsertSkeleton,
} from "./statement-skeleton.ts";

import { detectBank } from "./statement-parsers/index.ts";

const STATEMENT_BUCKET = "statement-pdfs";

// Sniff bank slug from the top of the PDF text as a last-ditch fallback
// (used when neither the hint nor detectBank(sender/subject) resolves).
function detectBankFromPdfText(text: string): string | null {
  const head = text.slice(0, 4000).toLowerCase();
  if (/amazon\s*pay.*icici|icici.*amazon\s*pay/.test(head)) return "amazon-pay-icici";
  if (/airtel.*axis|axis.*airtel/.test(head)) return "airtel-axis";
  if (/\baxis\s*bank\b/.test(head)) return "axis";
  if (/\bicici\s*bank\b/.test(head)) return "icici";
  if (/\bhdfc\s*bank\b|\bmillennia\b|\bregalia\b|\binfinia\b/.test(head)) return "hdfc";
  if (/sbi\s*card|sbicard|state\s*bank\s*of\s*india/.test(head)) return "sbi";
  if (/kotak\s*mahindra|\bkotak\b/.test(head)) return "kotak";
  if (/\byes\s*bank\b/.test(head)) return "yes bank";
  return null;
}

function canonicalBankSlug(slug: string | null | undefined): string | null {
  const s = (slug ?? "").toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (s.includes("amazon") && s.includes("icici")) return "amazon-pay-icici";
  if (s.includes("airtel") && s.includes("axis")) return "airtel-axis";
  if (s.includes("hdfc")) return "hdfc";
  if (s.includes("icici")) return "icici";
  if (s.includes("axis")) return "axis";
  if (s.includes("sbi")) return "sbi";
  if (s.includes("yes")) return "yes bank";
  if (s.includes("kotak")) return "kotak";
  return s;
}

export interface ExtractSummary {
  scanned: number;
  transactions: number;
  statements: number;
  skipped: number;
}

async function fetchBody(svc: SupabaseClient, account: any, email: any): Promise<string | null> {
  if (email.body_text) return email.body_text;
  if (email.provider !== "gmail" || !email.external_email_id) return email.snippet ?? null;
  try {
    const token = await ensureAccessToken(svc, account);
    const msg = await gapi(token, `/gmail/v1/users/me/messages/${email.external_email_id}?format=full`);
    const { text, html } = extractBody(msg.payload);
    const body = text ?? (html ? html.replace(/<[^>]+>/g, " ") : null);
    if (body) {
      await svc.from("emails").update({ body_text: text ?? body, body_html: html }).eq("id", email.id);
    }
    return body;
  } catch (e) {
    console.warn("fetchBody failed", e instanceof Error ? e.message : e);
    return email.snippet ?? null;
  }
}

// Fresh format=full fetch to get the message payload (needed for attachment
// listing — the cached body_text path in fetchBody() never retains this).
// Only called for emails already classified as a statement, so the extra
// Gmail API round trip is rare, not per-email.
async function fetchMessagePayload(svc: SupabaseClient, account: any, email: any): Promise<any | null> {
  if (email.provider !== "gmail" || !email.external_email_id) return null;
  try {
    const token = await ensureAccessToken(svc, account);
    const msg = await gapi(token, `/gmail/v1/users/me/messages/${email.external_email_id}?format=full`);
    return msg.payload ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("fetchMessagePayload failed", msg);
    // Bubble a distinct sentinel up so the caller can persist a diagnostic
    // parse_error instead of silently leaving the row 'pending' forever.
    throw new Error(`gmail_fetch_failed: ${msg}`);
  }
}

function digitsOnly(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

function suffixMatches(savedMasked: string | null | undefined, parsedLast4: string | null | undefined): boolean {
  const saved = digitsOnly(savedMasked);
  const parsed = digitsOnly(parsedLast4);
  if (!saved || !parsed) return false;
  return saved.endsWith(parsed) || parsed.endsWith(saved);
}

function normWords(v: string | null | undefined): string[] {
  return (v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !["your", "card", "credit", "monthly", "statement", "bank", "ltd", "the"].includes(w));
}

function bankMatches(bankName: string | null | undefined, slug: string | null): boolean {
  if (!bankName || !slug) return false;
  const a = bankName.toLowerCase();
  const b = slug.toLowerCase();
  return a.includes(b) || b.includes(a.replace(/\s+bank$/, ""));
}

function subjectTokenScore(subject: string | null | undefined, entityName: string | null | undefined): number {
  const hay = new Set(normWords(subject));
  return normWords(entityName).reduce((score, w) => score + (hay.has(w) ? 1 : 0), 0);
}

async function findBankId(svc: SupabaseClient, userId: string, bankSlug: string | null): Promise<string | null> {
  if (!bankSlug) return null;
  const { data: banks } = await svc.from("banks").select("id, name").eq("user_id", userId);
  const match = (banks ?? []).find((b: any) => bankMatches(b.name, bankSlug));
  return match?.id ?? null;
}

export async function resolveLinks(svc: SupabaseClient, userId: string, parsed: Parsed, email?: any) {
  const links: { financial_account_id?: string | null; credit_card_id?: string | null; loan_id?: string | null; linked_bank_id?: string | null; linked_card_id?: string | null } = {};
  const bankSlug = guessBankSlugFromSender(email?.from_email);
  const linkedBankId = await findBankId(svc, userId, bankSlug);
  if (linkedBankId) links.linked_bank_id = linkedBankId;

  if (parsed.kind === "statement") {
    const subject = email?.subject ?? "";
    if (parsed.statement_type === "card") {
      const { data: cards } = await svc.from("credit_cards")
        .select("id, bank_id, card_name, masked_number, banks(name)")
        .eq("user_id", userId);
      let best: any = null;
      let bestScore = 0;
      for (const card of cards ?? []) {
        let score = 0;
        if (suffixMatches(card.masked_number, parsed.last4)) score += 8;
        if (bankMatches(card.banks?.name, bankSlug)) score += 4;
        score += subjectTokenScore(subject, card.card_name) * 2;
        if (/cashback/i.test(subject) && /cashback/i.test(card.card_name)) score += 5;
        if (/bpcl/i.test(subject) && /bpcl/i.test(card.card_name)) score += 5;
        if (score > bestScore) { bestScore = score; best = card; }
      }
      if (best && bestScore >= 5) {
        links.credit_card_id = best.id;
        links.linked_card_id = best.id;
        links.linked_bank_id = best.bank_id ?? links.linked_bank_id ?? null;
        return links;
      }
    } else if (parsed.statement_type === "account") {
      const { data: accounts } = await svc.from("financial_accounts")
        .select("id, bank_id, nickname, masked_number, source_email, banks(name)")
        .eq("user_id", userId);
      let best: any = null;
      let bestScore = 0;
      for (const acct of accounts ?? []) {
        let score = 0;
        if (suffixMatches(acct.masked_number, parsed.last4)) score += 8;
        if (bankMatches(acct.banks?.name, bankSlug)) score += 4;
        if (acct.source_email && email?.from_email && String(email.from_email).toLowerCase().includes(String(acct.source_email).toLowerCase())) score += 4;
        score += subjectTokenScore(subject, acct.nickname) * 2;
        if (score > bestScore) { bestScore = score; best = acct; }
      }
      if (best && bestScore >= 5) {
        links.financial_account_id = best.id;
        links.linked_bank_id = best.bank_id ?? links.linked_bank_id ?? null;
        return links;
      }
    }
    return links;
  }

  if (!parsed.last4) return links;
  const suffix = `%${parsed.last4}`;
  if (parsed.kind === "transaction" || parsed.kind === "investment") {
    const { data: card } = await svc.from("credit_cards").select("id, bank_id").eq("user_id", userId).ilike("masked_number", suffix).maybeSingle();
    if (card) { links.credit_card_id = card.id; links.linked_card_id = card.id; links.linked_bank_id = card.bank_id ?? null; return links; }
    const { data: acct } = await svc.from("financial_accounts").select("id, bank_id").eq("user_id", userId).ilike("masked_number", suffix).maybeSingle();
    if (acct) { links.financial_account_id = acct.id; links.linked_bank_id = acct.bank_id ?? null; return links; }
  }
  if (parsed.kind === "emi") {
    const { data: loan } = await svc.from("loans").select("id").eq("user_id", userId).ilike("account_number", suffix).maybeSingle();
    if (loan) { links.loan_id = loan.id; return links; }
  }
  return links;
}

// For a statement, links.credit_card_id / links.financial_account_id may be
// unresolved (statement emails don't always carry a last4 the way alert
// emails do) — so this also falls back to matching the statement's own
// statement_type against the account/card that most recently expects a
// statement in this period. Keep it simple for now: only decrypt when a
// link was already resolved via last4; unresolved links mean parsing runs
// without a password (works fine for non-protected PDFs, fails clearly with
// wrong_or_missing_password otherwise, which is surfaced as parse_status).
async function resolveStatementPassword(
  svc: SupabaseClient,
  userId: string,
  links: { financial_account_id?: string | null; credit_card_id?: string | null },
): Promise<string | undefined> {
  const table = links.credit_card_id ? "credit_cards" : links.financial_account_id ? "financial_accounts" : null;
  const id = links.credit_card_id ?? links.financial_account_id ?? null;
  if (!table || !id) return undefined;
  const { data } = await svc.from(table).select("statement_password_rule").eq("user_id", userId).eq("id", id).maybeSingle();
  const rule = data?.statement_password_rule as StatementPasswordRule | null | undefined;
  if (!rule) return undefined;
  try {
    return await decryptStatementPassword(rule);
  } catch (e) {
    console.warn("decryptStatementPassword failed", e instanceof Error ? e.message : e);
    return undefined;
  }
}

// User-defined default candidates, stored in jarvis_memory under
// topic='finance.statement_password_candidates' as a JSON array of strings.
// Tried after the saved per-entity password but before giving up.
export async function loadPasswordCandidates(svc: SupabaseClient, userId: string): Promise<string[]> {
  try {
    const { data } = await svc.from("jarvis_memory")
      .select("content").eq("user_id", userId).eq("topic", "finance.statement_password_candidates").maybeSingle();
    if (!data?.content) return [];
    const parsed = JSON.parse(data.content);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch { return []; }
}

// After a successful rotation, persist the winning password onto the linked
// card/account so subsequent statements decrypt on the first attempt without
// re-cycling the candidate list.
export async function saveWinningPassword(
  svc: SupabaseClient,
  links: { financial_account_id?: string | null; credit_card_id?: string | null },
  winning: string,
): Promise<void> {
  const table = links.credit_card_id ? "credit_cards" : links.financial_account_id ? "financial_accounts" : null;
  const id = links.credit_card_id ?? links.financial_account_id ?? null;
  if (!table || !id) return;
  try {
    const { data } = await svc.from(table).select("statement_password_rule").eq("id", id).maybeSingle();
    if (data?.statement_password_rule) return; // don't overwrite an existing rule
    const rule = await encryptStatementPassword(winning);
    await svc.from(table).update({ statement_password_rule: rule }).eq("id", id);
  } catch (e) {
    console.warn("saveWinningPassword failed", e instanceof Error ? e.message : e);
  }
}

export async function findStoredStatementPdf(
  svc: SupabaseClient,
  statementId: string,
  statementFilePath?: string | null,
): Promise<{ storagePath: string; attachmentId?: string } | null> {
  // Always prefer the newest attachment row — it may carry an attachmentId we
  // want to update alongside the statement. Fall back to statementFilePath
  // only when no attachment row exists.
  const { data } = await svc.from("email_attachments")
    .select("id, storage_path")
    .eq("statement_id", statementId)
    .not("storage_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (data?.storage_path) return { storagePath: data.storage_path, attachmentId: data.id };
  if (statementFilePath) return { storagePath: statementFilePath };
  return null;
}

export async function parseStoredStatementPdf(
  svc: SupabaseClient,
  statementId: string,
  userId: string,
  links: { financial_account_id?: string | null; credit_card_id?: string | null; loan_id?: string | null; linked_bank_id?: string | null },
  opts: { statementFilePath?: string | null; password?: string | null; statement_type?: "card" | "account" | "loan" | null; bank_slug?: string | null; subject?: string | null; sender?: string | null; force_relearn?: boolean } = {},
): Promise<boolean> {
  const stored = await findStoredStatementPdf(svc, statementId, opts.statementFilePath ?? null);
  if (!stored) return false;
  const { error: pathErr } = await svc.from("statements")
    .update({ file_path: stored.storagePath })
    .eq("id", statementId)
    .select("id")
    .single();
  if (pathErr) {
    await svc.from("statements").update({
      parse_status: "failed",
      parse_error: "statement_file_path_update_failed",
      parse_reason: pathErr.message,
    }).eq("id", statementId);
    if (stored.attachmentId) await svc.from("email_attachments").update({ parse_status: "failed" }).eq("id", stored.attachmentId);
    return true;
  }
  const { data: blob, error: dlErr } = await svc.storage.from(STATEMENT_BUCKET).download(stored.storagePath);
  if (dlErr || !blob) {
    await svc.from("statements").update({
      file_path: stored.storagePath,
      parse_status: "failed",
      parse_error: "storage_download_failed",
      parse_reason: dlErr?.message ?? "Stored PDF could not be downloaded",
    }).eq("id", statementId);
    if (stored.attachmentId) await svc.from("email_attachments").update({ parse_status: "failed" }).eq("id", stored.attachmentId);
    return true;
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const savedPwd = await resolveStatementPassword(svc, userId, links);
  const candidates = await loadPasswordCandidates(svc, userId);
  const ordered = [opts.password ?? null, savedPwd, ...candidates].filter((x): x is string => typeof x === "string" && x.length > 0);
  const rotation = await parseStatementPdfWithPasswords(bytes, ordered, {
    bank_slug: opts.bank_slug ?? null,
    statement_type: opts.statement_type ?? null,
    subject: opts.subject ?? null,
    sender: opts.sender ?? null,
  });
  const pwdSource: PasswordSource = rotation.result.ok
    ? (rotation.winning_password == null ? "unprotected" : (savedPwd && rotation.winning_password === savedPwd ? "saved" : "candidate"))
    : "none";
  if (rotation.result.ok && rotation.winning_password && !savedPwd) {
    await saveWinningPassword(svc, links, rotation.winning_password);
  }
  // Skeleton-learner fallback: if regex parsing missed required fields but
  // we did extract text, learn (or reuse) a per-bank skeleton and re-derive
  // the fields via cached anchors — no LLM cost on subsequent statements of
  // the same layout.
  const finalResult = await runSkeletonFallback(
    svc, userId, statementId, rotation.result,
    { bank_slug: opts.bank_slug ?? null, statement_type: opts.statement_type ?? null, subject: opts.subject ?? null, sender: opts.sender ?? null, force_relearn: opts.force_relearn ?? false, links },
  );
  await applyParsedStatementResult(svc, statementId, userId, links, finalResult.result, stored.storagePath, stored.attachmentId, pwdSource, finalResult.skeleton_id);
  return true;
}

// Shared skeleton-learner post-step used by both stored-PDF and inline-
// attachment paths. Runs on every parse to (a) return the cached-skeleton
// values when available, (b) LEARN on first sight so month 2 skips the
// regex, and (c) short-circuit account statements (info-only, no due/total).
export async function runSkeletonFallback(
  svc: SupabaseClient,
  userId: string,
  statementId: string,
  result: Awaited<ReturnType<typeof parseStatementPdfWithPasswords>>["result"],
  hint: {
    bank_slug: string | null;
    statement_type: "card" | "account" | "loan" | null;
    subject: string | null;
    sender?: string | null;
    force_relearn?: boolean;
    links?: { credit_card_id?: string | null; financial_account_id?: string | null; loan_id?: string | null };
  },
): Promise<{ result: typeof result; skeleton_id: string | null }> {
  const text = result.extracted_text ?? "";
  const bumpAttempts = async (note?: string) => {
    // Track every learner pass so operators can see why a bank still has no
    // skeleton. Errors during learn are surfaced into parse_reason so they
    // stop being invisible failures.
    try {
      const { data: cur } = await svc.from("statements")
        .select("learn_attempts, parse_reason").eq("id", statementId).maybeSingle();
      const attempts = (cur?.learn_attempts ?? 0) + 1;
      const patch: Record<string, unknown> = {
        learn_attempts: attempts,
        last_learn_at: new Date().toISOString(),
      };
      if (note) patch.parse_reason = `${cur?.parse_reason ?? ""}${cur?.parse_reason ? " · " : ""}skeleton: ${note}`.slice(0, 500);
      await svc.from("statements").update(patch).eq("id", statementId);
    } catch (_) { /* best-effort */ }
  };
  if (!text) { await bumpAttempts("no extracted_text"); return { result, skeleton_id: null }; }
  const bank_slug = canonicalBankSlug(
    hint.bank_slug ??
    detectBank(text, { subject: hint.subject ?? null, sender: hint.sender ?? null }) ??
    detectBankFromPdfText(text)
  );
  if (!bank_slug) { await bumpAttempts("bank_slug not detected"); return { result, skeleton_id: null }; }

  const links = hint.links ?? {};
  let statement_type: "card" | "account" | "loan" =
    hint.statement_type ??
    (links.credit_card_id ? "card"
      : links.financial_account_id ? "account"
      : links.loan_id ? "loan"
      : detectTypeFromText(text, hint.subject ?? null));

  await bumpAttempts();

  try {
    const fp = await layoutFingerprint(text);

    // 1) Exact cached skeleton — fastest path.
    let cached = hint.force_relearn
      ? null
      : await loadSkeleton(svc, userId, bank_slug, statement_type, null, fp);

    if (cached) {
      const applied = applySkeleton(text, cached.skeleton);
      if (applied.ok) {
        await recordSkeletonOutcome(svc, cached.id, true).catch(() => {});
        return { result: { ...applied, extracted_text: text }, skeleton_id: cached.id };
      }
      await recordSkeletonOutcome(svc, cached.id, false).catch(() => {});
    }

    // 2) LLM learn on first sight — do not swallow upsert errors.
    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (apiKey) {
      let learned = null as Awaited<ReturnType<typeof learnSkeleton>> | null;
      try {
        learned = await learnSkeleton({
          text, bank_slug, statement_type, apiKey, subject: hint.subject ?? null,
        });
      } catch (le) {
        await bumpAttempts(`learn failed: ${le instanceof Error ? le.message : String(le)}`);
      }
      if (learned) {
        let up: Awaited<ReturnType<typeof upsertSkeleton>> = null;
        try {
          up = await upsertSkeleton(svc, userId, {
            bank_slug, statement_type, variant: learned.variant,
            layout_fingerprint: fp, skeleton: learned,
            sample_statement_id: statementId,
          });
        } catch (ue) {
          await bumpAttempts(`upsert failed: ${ue instanceof Error ? ue.message : String(ue)}`);
        }
        const applied = applySkeleton(text, learned);
        if (applied.ok) {
          if (up?.id) await recordSkeletonOutcome(svc, up.id, true).catch(() => {});
          return { result: { ...applied, extracted_text: text }, skeleton_id: up?.id ?? null };
        }
        if (up?.id) await recordSkeletonOutcome(svc, up.id, false).catch(() => {});
        const merged = mergeParseResults(result, { ...applied, extracted_text: text });
        return { result: merged, skeleton_id: up?.id ?? null };
      }
    } else {
      await bumpAttempts("LOVABLE_API_KEY missing");
    }

    // 3) LLM unavailable — synthesize canonical skeleton so next retry has
    // anchors. Do not swallow the upsert error.
    const skeleton = synthesizeSkeletonFromResult({
      bank_slug, statement_type,
      parser_source: result.parser_source ?? "regex",
      result: {
        ok: true,
        fields: {
          period_start: result.period_start,
          period_end: result.period_end,
          statement_date: result.statement_date,
          due_date: result.due_date,
          total_due: result.total_due,
          min_due: result.min_due,
          closing_balance: result.closing_balance,
          lines: result.lines,
        },
        parser_source: result.parser_source ?? "regex",
        confidence: result.parse_confidence ?? 0.6,
        missing_fields: [],
      },
    });
    let up: Awaited<ReturnType<typeof upsertSkeleton>> = null;
    try {
      up = await upsertSkeleton(svc, userId, {
        bank_slug, statement_type, variant: null,
        layout_fingerprint: fp, skeleton, sample_statement_id: statementId,
      });
    } catch (ue) {
      await bumpAttempts(`synth upsert failed: ${ue instanceof Error ? ue.message : String(ue)}`);
    }
    const applied = applySkeleton(text, skeleton);
    const merged = mergeParseResults(result, { ...applied, extracted_text: text });
    return { result: merged, skeleton_id: up?.id ?? null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("skeleton pipeline failed", msg);
    await bumpAttempts(`pipeline error: ${msg}`);
    return { result, skeleton_id: null };
  }
}

// Heuristic: card vs account when the statement row has no link yet.
function detectTypeFromText(text: string, subject: string | null): "card" | "account" | "loan" {
  const hay = `${subject ?? ""} ${text.slice(0, 4000)}`.toLowerCase();
  if (/\bcredit\s*card\b|\bcard\s*statement\b|\bcard\s*ending\b|\bpayment\s*due\s*date\b/.test(hay)) return "card";
  if (/\bloan\b|\bemi\b|\bprincipal\s*outstanding\b/.test(hay)) return "loan";
  if (/\bsavings\b|\bcurrent\s*account\b|\baccount\s*statement\b|\baccount\s*summary\b|\bopening\s*balance\b/.test(hay)) return "account";
  // Default to card only when we truly can't tell — accounts don't page us
  // for missing due dates, so a wrong default here is less noisy for accounts.
  return "card";
}

// Prefer the truthy value from the skeleton result but fall back to regex.
function mergeParseResults(
  regex: Awaited<ReturnType<typeof parseStatementPdfWithPasswords>>["result"],
  skel: Awaited<ReturnType<typeof parseStatementPdfWithPasswords>>["result"],
): typeof regex {
  const pick = <K extends keyof typeof regex>(k: K) =>
    (skel[k] ?? null) !== null && (skel[k] ?? null) !== undefined ? skel[k] : regex[k];
  return {
    ok: regex.ok || skel.ok,
    period_start: pick("period_start"),
    period_end: pick("period_end"),
    statement_date: pick("statement_date"),
    due_date: pick("due_date"),
    total_due: pick("total_due"),
    min_due: pick("min_due"),
    closing_balance: pick("closing_balance"),
    lines: skel.lines.length > regex.lines.length ? skel.lines : regex.lines,
    parser_source: `${regex.parser_source ?? "regex"}+${skel.parser_source ?? "skeleton"}`,
    parse_confidence: Math.max(regex.parse_confidence ?? 0, skel.parse_confidence ?? 0),
    extracted_text: regex.extracted_text ?? skel.extracted_text ?? null,
    error: undefined,
  } as typeof regex;
}


function safeName(filename: string): string {
  return filename.replace(/[^\w.\-]/g, "_").slice(0, 80);
}

// Downloads the statement's first PDF attachment (if any), stores it in the
// private statement-pdfs bucket, parses it (decrypting with the linked
// card/account's stored password when available), and writes the results
// back onto the statements row + itemized transactions. Never throws — a
// parse failure just leaves parse_status='failed' and the sync run
// continues with the next email.
export async function ingestStatementAttachment(
  svc: SupabaseClient,
  account: any,
  email: any,
  statementId: string,
  links: { financial_account_id?: string | null; credit_card_id?: string | null; loan_id?: string | null; linked_bank_id?: string | null },
  opts: { statement_type?: "card" | "account" | "loan" | null; bank_slug?: string | null; force_relearn?: boolean } = {},
): Promise<void> {
  // Central helper: every early-exit path writes a specific parse_error +
  // parse_reason so the UI never shows a bare "PENDING" chip again.
  const failStatement = async (parse_error: string, parse_reason: string, status: "failed" | "pending" = "failed") => {
    try {
      await svc.from("statements").update({
        parse_status: status, parse_error, parse_reason,
      }).eq("id", statementId);
    } catch (_) { /* swallow — nothing else we can do */ }
  };

  try {
    // Fast path: if we already have a stored PDF for this statement, parse
    // that first. Avoids re-downloading and eliminates the false "no PDF
    // attachment" skip when Gmail's format=full payload has since drifted.
    const alreadyStored = await findStoredStatementPdf(svc, statementId, null);
    if (alreadyStored) {
      const handled = await parseStoredStatementPdf(svc, statementId, email.user_id, links, {
        statementFilePath: alreadyStored.storagePath,
        statement_type: opts.statement_type ?? null,
        bank_slug: opts.bank_slug ?? null,
        subject: email.subject ?? null,
        sender: email.from_email ?? null,
      });
      if (handled) return;
    }

    let payload: any = null;
    try {
      payload = await fetchMessagePayload(svc, account, email);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await failStatement("gmail_fetch_failed", msg);
      return;
    }
    if (!payload) {
      // Non-gmail provider or empty payload — record it instead of dropping.
      await failStatement("gmail_payload_empty", `provider=${email.provider ?? "unknown"} external_id=${email.external_email_id ?? "-"}`);
      return;
    }

    const pdfAttachment = listAttachments(payload).find((a) =>
      a.mimeType === "application/pdf" || /\.pdf$/i.test(a.filename ?? "")
    );
    if (!pdfAttachment) {
      // "Login to view" notifications, common for many banks. Keep the row
      // skipped so bulk reparse doesn't churn forever; the user must attach
      // the downloaded PDF from the UI.
      await failStatement(
        "no_pdf_attachment_login_required",
        "No PDF attached to this email — likely a 'login to view' notification. Attach a PDF to parse.",
        "skipped",
      );
      return;
    }

    let bytes: Uint8Array;
    try {
      const token = await ensureAccessToken(svc, account);
      bytes = await downloadAttachment(token, email.external_email_id, pdfAttachment.attachmentId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("downloadAttachment failed", msg);
      await failStatement("attachment_download_failed", msg);
      return;
    }

    const storagePath = `${email.user_id}/${email.id}/${pdfAttachment.attachmentId}-${safeName(pdfAttachment.filename)}`;

    // Purge any previously stored PDF for this statement whose path differs
    // from the new one — otherwise a re-fetch leaves the old object behind
    // (a rename in Gmail, a corrected attachment, a manual reupload).
    try {
      const { data: prev } = await svc.from("statements").select("file_path").eq("id", statementId).maybeSingle();
      if (prev?.file_path && prev.file_path !== storagePath) {
        await svc.storage.from(STATEMENT_BUCKET).remove([prev.file_path]);
      }
    } catch (_) { /* best effort */ }

    const { error: upErr } = await svc.storage.from(STATEMENT_BUCKET).upload(storagePath, bytes, {
      contentType: "application/pdf",
      upsert: true,
    });
    if (upErr) {
      console.warn("statement PDF upload failed", upErr.message);
      await failStatement("storage_upload_failed", upErr.message);
      return;
    }
    const { error: filePathErr } = await svc.from("statements")
      .update({ file_path: storagePath })
      .eq("id", statementId)
      .select("id")
      .single();
    if (filePathErr) {
      await failStatement("statement_file_path_update_failed", filePathErr.message);
      return;
    }

    const attFields = {
      file_name: pdfAttachment.filename,
      mime: pdfAttachment.mimeType,
      storage_path: storagePath,
      byte_size: bytes.length,
      attachment_type: "statement",
      parse_status: "pending",
    };
    const { data: existingAtt } = await svc.from("email_attachments")
      .select("id").eq("email_id", email.id).eq("statement_id", statementId).limit(1).maybeSingle();

    let attRow: { id: string } | null;
    if (existingAtt) {
      const { data, error } = await svc.from("email_attachments").update(attFields).eq("id", existingAtt.id).select("id").single();
      if (error) { await failStatement("attachment_row_update_failed", error.message); return; }
      attRow = data;
    } else {
      const { data, error } = await svc.from("email_attachments").insert({
        user_id: email.user_id, email_id: email.id, statement_id: statementId, ...attFields,
      }).select("id").single();
      if (error) { await failStatement("attachment_row_insert_failed", error.message); return; }
      attRow = data;
    }
    if (!attRow) { await failStatement("attachment_row_missing", "no attachment row after insert"); return; }

    // Password rotation: saved rule → user's default candidates → no-password.
    const savedPwd = await resolveStatementPassword(svc, email.user_id, links);
    const candidates = await loadPasswordCandidates(svc, email.user_id);
    const ordered = [savedPwd, ...candidates].filter((x): x is string => typeof x === "string" && x.length > 0);
    const rotation = await parseStatementPdfWithPasswords(bytes, ordered, {
      bank_slug: opts.bank_slug ?? null,
      statement_type: opts.statement_type ?? null,
      subject: email.subject ?? null,
      sender: email.from_email ?? null,
    });
    // Determine which source produced the winning password (for parse_reason).
    let pwdSource: "saved" | "candidate" | "none" | "unprotected" = "unprotected";
    if (rotation.result.ok) {
      if (rotation.winning_password == null) pwdSource = "unprotected";
      else if (savedPwd && rotation.winning_password === savedPwd) pwdSource = "saved";
      else pwdSource = "candidate";
    } else {
      pwdSource = "none";
    }
    if (rotation.result.ok && rotation.winning_password && !savedPwd) {
      await saveWinningPassword(svc, links, rotation.winning_password);
    }
    const finalResult = await runSkeletonFallback(
      svc, email.user_id, statementId, rotation.result,
      { bank_slug: opts.bank_slug ?? null, statement_type: opts.statement_type ?? null, subject: email.subject ?? null, sender: email.from_email ?? null, force_relearn: opts.force_relearn ?? false, links },
    );
    await applyParsedStatementResult(
      svc, statementId, email.user_id, links, finalResult.result, storagePath, attRow.id, pwdSource, finalResult.skeleton_id,
    );
  } catch (e) {
    // Absolute backstop — should never happen, but if it does we still leave
    // a diagnostic on the row rather than a silent 'pending'.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("ingestStatementAttachment crashed", msg);
    await failStatement("ingest_crashed", msg);
  }
}

// Purge every derived artifact for a statement so a retry runs identically to
// a fresh ingest — no half-written fields, no orphan transactions from a
// prior wrong-card link, no stale attachment row pointing at a superseded
// storage object.
// Wipes the derived state of a statement so a retry runs identically to a
// fresh ingest. By default the stored PDF bytes are KEPT (retries usually
// want to re-parse the same file), and `file_path` on the statements row is
// left intact so `parseStoredStatementPdf` can still locate the object. Pass
// `{ deleteStoredPdf: true }` to also purge storage (e.g. after a corrupt
// upload).
export async function purgeStatementDerived(
  svc: SupabaseClient,
  statementId: string,
  opts: { deleteStoredPdf?: boolean } = {},
): Promise<void> {
  const { data: prev } = await svc.from("statements")
    .select("file_path").eq("id", statementId).maybeSingle();
  if (opts.deleteStoredPdf && prev?.file_path) {
    try { await svc.storage.from(STATEMENT_BUCKET).remove([prev.file_path]); }
    catch (e) { console.warn("purge storage failed", e instanceof Error ? e.message : e); }
  }
  await svc.from("transactions").delete().eq("source_statement_id", statementId);
  // Preserve the email_attachments row so the stored PDF stays discoverable
  // via findStoredStatementPdf; just reset its parse status.
  await svc.from("email_attachments")
    .update({ parse_status: "pending", extracted_text: null })
    .eq("statement_id", statementId).eq("attachment_type", "statement");
  const patch: Record<string, unknown> = {
    transactions_found: 0,
    closing_balance: null,
    total_due: null,
    min_due: null,
    due_date: null,
    period_start: null,
    period_end: null,
    statement_date: null,
    parser_source: null,
    parse_confidence: null,
    parser_confidence: null,
    parse_error: null,
    parse_reason: null,
    skeleton_id: null,
    payment_status: "na",
    paid_amount: null,
    paid_on: null,
    ai_summary: null,
  };
  if (opts.deleteStoredPdf) patch.file_path = null;
  await svc.from("statements").update(patch).eq("id", statementId);
}

// Deterministic post-parse enrichment: normalize the raw merchant string
// coming from a statement line, guess a category from a small keyword map,
// and infer payment_mode from the description shape. No LLM — keeps the
// tail of applyParsedStatementResult fast + free.
function enrich(description: string, txnType: "debit" | "credit"): {
  merchant: string;
  category: string | null;
  payment_mode: string | null;
  merchant_normalized: string | null;
} {
  const raw = description.trim();
  // Strip common trailing card refs, city codes, POS terminal ids, and
  // padding characters that make merchants look different across rows.
  let merchant = raw
    .replace(/\s+(?:POS|ATM|NEFT|IMPS|RTGS|UPI|ECOM)\b.*$/i, "")
    .replace(/\s+X{2,}\d{2,}\b.*$/i, "")
    .replace(/\s+\*{2,}\d{2,}\b.*$/i, "")
    .replace(/\s+\b(?:BANGALORE|BENGALURU|MUMBAI|DELHI|NOIDA|GURGAON|GURUGRAM|PUNE|HYDERABAD|CHENNAI|KOLKATA|IN)\b\s*$/i, "")
    .replace(/\s+\d{6,}$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!merchant) merchant = raw;

  const merchant_normalized = merchant
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|india|in|payments?|services?|brands?|designs?)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || null;

  const hay = raw.toLowerCase();
  const CATEGORIES: Array<[RegExp, string]> = [
    [/\b(swiggy|zomato|dominos|kfc|mcdonald|starbucks|cafe|restaurant|food|eatclub|eatsure|freshmenu|faasos|behrouz)\b/, "Food & Dining"],
    [/\b(uber|ola|rapido|indigo|vistara|air ?india|irctc|redbus|makemytrip|goibibo|metro|fuel|petrol|hpcl|bpcl|iocl)\b/, "Travel"],
    [/\b(amazon|flipkart|myntra|ajio|meesho|nykaa)\b/, "Shopping"],
    [/\b(bigbasket|blinkit|zepto|dmart|grocery|instamart)\b/, "Groceries"],
    [/\b(netflix|spotify|prime|hotstar|youtube|apple\.com\/bill|google|microsoft|adobe|icloud)\b/, "Subscriptions"],
    [/\b(bses|adani|tata power|electric|water|gas|jio|airtel|vi |vodafone|bsnl|broadband)\b/, "Utilities"],
    [/\b(apollo|medplus|pharm|clinic|hospital|diagnostic|1mg|pharmeasy)\b/, "Health"],
    [/\b(rent|maintenance|society|housing)\b/, "Housing"],
    [/\b(emi|loan|installment|finance charge|late fee|overlimit|annual fee|joining fee|fee,? taxes|gst)\b/, "Fees & Charges"],
    [/\b(sip|mutual fund|nps|invest|zerodha|groww|upstox)\b/, "Investments"],
    [/\b(salary|payroll|credit interest|refund|reversal|cashback)\b/, txnType === "credit" ? "Income" : "Refunds"],
    [/\b(atm|cash withdrawal)\b/, "Cash"],
  ];
  const category = CATEGORIES.find(([rx]) => rx.test(hay))?.[1] ?? null;

  let payment_mode: string | null = null;
  if (/\bupi\b|@[a-z]/i.test(raw)) payment_mode = "UPI";
  else if (/\b(neft|imps|rtgs)\b/i.test(raw)) payment_mode = "Bank Transfer";
  else if (/\bpos\b|\bcard\b|\becom\b|\b(visa|mastercard|rupay)\b/i.test(raw)) payment_mode = "Card";
  else if (/\batm\b|\bcash\b/i.test(raw)) payment_mode = "Cash";
  else if (/\bauto[- ]?debit\b|\bsi\b|\bstanding instruction\b/i.test(raw)) payment_mode = "Auto-debit";

  return { merchant, category, payment_mode, merchant_normalized };
}

// Shared tail of statement ingestion, reused by both the Gmail-attachment
// path above and the manual-upload edge function (finance-upload-statement)
// — writes the parse result onto the statements/email_attachments rows and
// inserts itemized transactions with the same dedup-against-email-alerts
// logic. attachmentId is optional since a manual upload may not create an
// email_attachments row.
export type PasswordSource = "saved" | "candidate" | "unprotected" | "none";
export { computeCardPaymentStatus } from "./card-payment-status.ts";

function reasonForParseError(err: string | undefined | null): string {
  const e = (err ?? "").toLowerCase();
  if (!e) return "unknown_parse_error";
  if (e.includes("password_required")) return "password_missing";
  if (e.includes("wrong_password") || e.includes("wrong_or_missing_password")) return "password_failed";
  if (e.includes("file_too_large")) return "pdf_too_large";
  if (e.includes("too_many_pages")) return "pdf_too_many_pages";
  if (e.includes("stored_password_unreadable")) return "stored_password_unreadable";
  return err ?? "unknown_parse_error";
}

function reasonForSuccess(src: PasswordSource): string {
  switch (src) {
    case "saved": return "parsed_with_saved_password";
    case "candidate": return "parsed_with_user_password";
    case "unprotected": return "parsed_no_password";
    default: return "parsed";
  }
}

function missingRequiredParsedFields(
  statementType: "card" | "account" | "loan",
  result: import("./statement-pdf.ts").PdfParseResult,
): string[] {
  const required = statementType === "card"
    ? ["statement_date", "due_date", "total_due"]
    : statementType === "loan"
    ? ["statement_date"]
    : ["statement_date"];
  return required.filter((key) => (result as any)[key] == null);
}

export async function applyParsedStatementResult(
  svc: SupabaseClient,
  statementId: string,
  userId: string,
  links: { financial_account_id?: string | null; credit_card_id?: string | null; loan_id?: string | null; linked_bank_id?: string | null },
  result: import("./statement-pdf.ts").PdfParseResult,
  storagePath: string | null,
  attachmentId?: string,
  passwordSource: PasswordSource = "none",
  skeletonId: string | null = null,
): Promise<void> {
  if (!result.ok) {
    if (attachmentId && result.extracted_text) {
      await svc.from("email_attachments").update({ extracted_text: result.extracted_text.slice(0, 200_000) }).eq("id", attachmentId);
    }
    await svc.from("statements").update({
      parse_status: "failed",
      parse_error: result.error ?? "unknown_parse_error",
      parse_reason: reasonForParseError(result.error),
      file_path: storagePath,
      parser_source: result.parser_source ?? null,
      period_start: result.period_start ?? undefined,
      period_end: result.period_end ?? undefined,
      statement_date: result.statement_date ?? undefined,
      skeleton_id: skeletonId,
    }).eq("id", statementId);
    if (attachmentId) await svc.from("email_attachments").update({ parse_status: "failed" }).eq("id", attachmentId);
    return;
  }

  if (attachmentId && result.extracted_text) {
    await svc.from("email_attachments").update({ extracted_text: result.extracted_text.slice(0, 200_000) }).eq("id", attachmentId);
  }

  // Card statements track payment lifecycle; accounts/loans stay 'na'.
  const { data: existing } = await svc.from("statements")
    .select("statement_type, payment_status, paid_amount")
    .eq("id", statementId).maybeSingle();
  const resolvedStatementType = (existing?.statement_type ?? "card") as "card" | "account" | "loan";
  const isCard = resolvedStatementType === "card";
  const missingRequired = missingRequiredParsedFields(resolvedStatementType, result);
  if (missingRequired.length > 0) {
    await svc.from("statements").update({
      parse_status: "failed",
      parse_error: `missing_fields:${missingRequired.join(",")}`,
      parse_reason: `${resolvedStatementType} statement parsed from PDF but required fields are still missing`,
      transactions_found: result.lines.length,
      file_path: storagePath,
      parser_source: result.parser_source ?? "generic",
      parse_confidence: result.parse_confidence ?? null,
      parser_confidence: result.parse_confidence ?? null,
      period_start: result.period_start,
      period_end: result.period_end,
      statement_date: result.statement_date,
      due_date: result.due_date,
      total_due: result.total_due,
      min_due: result.min_due,
      closing_balance: result.closing_balance,
      skeleton_id: skeletonId,
    }).eq("id", statementId);
    if (attachmentId) await svc.from("email_attachments").update({ parse_status: "failed" }).eq("id", attachmentId);
    return;
  }
  const paymentUpdate = isCard
    ? { payment_status: computeCardPaymentStatus(
        existing?.payment_status ?? null,
        Number(existing?.paid_amount ?? 0),
        result.total_due,
        result.due_date,
      ) }
    : { payment_status: "na" as const };

  const { error: stErr } = await svc.from("statements").update({
    period_start: result.period_start,
    period_end: result.period_end,
    statement_date: result.statement_date,
    due_date: result.due_date,
    total_due: result.total_due,
    min_due: result.min_due,
    closing_balance: result.closing_balance,
    parse_status: "parsed",
    parse_error: null,
    parse_reason: reasonForSuccess(passwordSource),
    transactions_found: result.lines.length,
    file_path: storagePath,
    parser_source: result.parser_source ?? "generic",
    parse_confidence: result.parse_confidence ?? null,
    parser_confidence: result.parse_confidence ?? null,
    credit_card_id: links.credit_card_id ?? null,
    financial_account_id: links.financial_account_id ?? null,
    loan_id: links.loan_id ?? null,
    linked_bank_id: links.linked_bank_id ?? null,
    skeleton_id: skeletonId,
    ...paymentUpdate,
  }).eq("id", statementId).select("id").single();
  if (stErr) {
    await svc.from("statements").update({
      parse_status: "failed",
      parse_error: "statement_update_failed",
      parse_reason: stErr.message,
      file_path: storagePath,
    }).eq("id", statementId);
    if (attachmentId) await svc.from("email_attachments").update({ parse_status: "failed" }).eq("id", attachmentId);
    return;
  }
  if (attachmentId) await svc.from("email_attachments").update({ parse_status: "parsed" }).eq("id", attachmentId);

  // Card lifecycle: mirror the latest statement onto the linked credit_card
  // so Cards list can show due-date/total-due/payment_status without
  // re-scanning statements.
  if (isCard && links.credit_card_id) {
    await svc.from("credit_cards").update({
      latest_statement_id: statementId,
      latest_due_date: result.due_date ?? null,
      latest_total_due: result.total_due ?? null,
      latest_min_due: result.min_due ?? null,
      payment_status: (paymentUpdate as any).payment_status ?? null,
    }).eq("id", links.credit_card_id).catch?.(() => {});
  }

  // Now safe to purge old statement-derived transactions — the new parse is
  // committed on the statements row, so we won't orphan the statement if a
  // later insert fails.
  await svc.from("transactions").delete().eq("source_statement_id", statementId);


  const idCol = links.credit_card_id ? "credit_card_id" : links.financial_account_id ? "financial_account_id" : null;
  const idVal = links.credit_card_id ?? links.financial_account_id ?? null;

  for (const line of result.lines) {
    // Dedup against an already-extracted source='email' transaction for the
    // same real-world charge (account/card + date + amount). If found,
    // upgrade it to source='statement' rather than inserting a duplicate —
    // the statement line is the more authoritative record.
    let existingId: string | null = null;
    if (idCol && idVal) {
      const { data: existing } = await svc.from("transactions")
        .select("id, source")
        .eq("user_id", userId)
        .eq(idCol, idVal)
        .eq("txn_date", line.date)
        .eq("amount", line.amount)
        .maybeSingle();
      if (existing) existingId = existing.id;
    }

    if (existingId) {
      await svc.from("transactions").update({
        source: "statement",
        source_statement_id: statementId,
        confidence_score: 0.85,
        description: line.description,
      }).eq("id", existingId);
    } else {
      const en = enrich(line.description, line.txn_type);
      const { error: te } = await svc.from("transactions").insert({
        user_id: userId,
        txn_date: line.date,
        amount: line.amount,
        txn_type: line.txn_type,
        merchant: en.merchant,
        description: line.description,
        category: en.category,
        payment_mode: en.payment_mode,
        merchant_normalized: en.merchant_normalized,
        source: "statement",
        source_statement_id: statementId,
        credit_card_id: links.credit_card_id ?? null,
        financial_account_id: links.financial_account_id ?? null,
        loan_id: links.loan_id ?? null,
        confidence_score: 0.85,
      });
      if (te && !String(te.message).includes("duplicate")) {
        console.warn("statement txn insert", te.message);
        await svc.from("statements").update({
          parse_error: "transaction_insert_partial_failure",
          parse_reason: te.message,
        }).eq("id", statementId);
      }
    }
  }
}

export async function extractFinanceForAccount(
  svc: SupabaseClient,
  account: any,
  opts: { sinceDays?: number; limit?: number } = {},
): Promise<ExtractSummary> {
  const sinceDays = Math.max(1, Math.min(365, opts.sinceDays ?? 30));
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const cutoff = new Date(Date.now() - sinceDays * 86400_000).toISOString();

  const { data: candidates, error } = await svc
    .from("emails")
    .select("id, user_id, account_id, provider, external_email_id, from_email, from_name, subject, snippet, body_text, received_at, finance_related")
    .eq("account_id", account.id)
    .eq("user_id", account.user_id)
    .gte("received_at", cutoff)
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  let transactions = 0, statements = 0, skipped = 0;

  for (const em of candidates ?? []) {
    // Forwarded-mail unwrap: dedicated forwarding inboxes (07statement@…)
    // show only the user as `from:`, so pull the original headers out of
    // the quoted forward block first. Use the unwrapped view for detection.
    const outerBody = em.body_text ?? em.snippet ?? null;
    const unwrapped = unwrapForwarded({ ...em, body_text: outerBody });
    const detectionView = {
      ...em,
      from_email: unwrapped.from_email ?? em.from_email,
      from_name: unwrapped.from_name ?? em.from_name,
      subject: unwrapped.subject ?? em.subject,
      body_text: unwrapped.body_text ?? outerBody,
    };
    const treatAll = !!account?.treat_all_as_finance;
    const looksFinance = treatAll || em.finance_related || isFinanceMail(detectionView) || isFinanceSender(detectionView.from_email);
    if (!looksFinance) { skipped++; continue; }
    if (!em.finance_related) {
      await svc.from("emails").update({ finance_related: true, category: "finance" }).eq("id", em.id);
    }

    // Skip if already extracted (idempotency via unique index) — except a
    // statement stuck at parse_status='pending'/'failed', which gets
    // retried. Covers rows from before this pipeline existed (always
    // 'pending', never processed) and rows that failed transiently (e.g. no
    // password set at the time of first attempt).
    const { data: exTx } = await svc.from("transactions").select("id").eq("user_id", em.user_id).eq("source_email_id", em.id).maybeSingle();
    const { data: exSt } = await svc.from("statements")
      .select("id, parse_status, parse_reason, file_path, credit_card_id, financial_account_id, loan_id, linked_bank_id")
      .eq("user_id", em.user_id).eq("source_email_id", em.id).maybeSingle();
    if (exTx) { skipped++; continue; }
    if (exSt) {
      const body = await fetchBody(svc, account, em);
      const unwrappedRe = unwrapForwarded({ ...em, body_text: body });
      const parseView = { ...em, ...unwrappedRe, body_text: unwrappedRe.body_text ?? body };
      const parsedExisting = parseFinanceEmail(parseView);
      const refreshedLinks = parsedExisting?.kind === "statement"
        ? await resolveLinks(svc, em.user_id, parsedExisting, parseView)
        : {
          credit_card_id: exSt.credit_card_id,
          financial_account_id: exSt.financial_account_id,
          loan_id: exSt.loan_id,
          linked_bank_id: exSt.linked_bank_id,
        };
      const finalLinks = {
        credit_card_id: refreshedLinks.credit_card_id ?? exSt.credit_card_id ?? null,
        financial_account_id: refreshedLinks.financial_account_id ?? exSt.financial_account_id ?? null,
        loan_id: refreshedLinks.loan_id ?? exSt.loan_id ?? null,
        linked_bank_id: (refreshedLinks as any).linked_bank_id ?? exSt.linked_bank_id ?? null,
      };
      if (parsedExisting?.kind === "statement") {
        const hasEntity = !!(finalLinks.credit_card_id || finalLinks.financial_account_id || finalLinks.loan_id);
        // Only clear parse_error when we have a real entity link now; don't
        // clobber a more specific prior error (e.g. wrong_or_missing_password)
        // with a generic "unlinked" reason.
        const patch: Record<string, unknown> = {
          statement_type: parsedExisting.statement_type,
          credit_card_id: finalLinks.credit_card_id,
          financial_account_id: finalLinks.financial_account_id,
          loan_id: finalLinks.loan_id,
          linked_bank_id: finalLinks.linked_bank_id,
        };
        if (hasEntity) patch.parse_error = null;
        await svc.from("statements").update(patch).eq("id", exSt.id);
      }
      if (exSt.parse_status === "pending" || exSt.parse_status === "failed" || exSt.parse_status === "skipped") {
        const handledFromStorage = await parseStoredStatementPdf(svc, exSt.id, em.user_id, finalLinks, {
          statementFilePath: exSt.file_path ?? null,
          bank_slug: guessBankSlugFromSender(parseView.from_email ?? em.from_email),
          statement_type: (parsedExisting?.kind === "statement" ? parsedExisting.statement_type : null),
          subject: parseView.subject ?? em.subject ?? null,
          sender: parseView.from_email ?? em.from_email ?? null,
        });
        if (!handledFromStorage) {
          // Purge derived data first so retry runs identically to a fresh
          // ingest — no leftover fields from a prior wrong-link attempt.
          await purgeStatementDerived(svc, exSt.id);
          await ingestStatementAttachment(svc, account, em, exSt.id, finalLinks, {
            statement_type: (parsedExisting?.kind === "statement" ? parsedExisting.statement_type : null),
            bank_slug: guessBankSlugFromSender(parseView.from_email ?? em.from_email),
          });
        }
      }
      skipped++;
      continue;
    }

    const body = await fetchBody(svc, account, em);
    const unwrappedNew = unwrapForwarded({ ...em, body_text: body });
    const parseView = { ...em, ...unwrappedNew, body_text: unwrappedNew.body_text ?? body };
    const parsed = parseFinanceEmail(parseView);
    if (!parsed) { skipped++; continue; }

    const links = await resolveLinks(svc, em.user_id, parsed, parseView);


    // Guess the issuing bank from the sender domain — used for display when
    // no card/account link resolves. Also useful for downstream filtering.
    let linkedBankId: string | null = null;
    const bankSlug = guessBankSlugFromSender(parseView.from_email ?? em.from_email);
    linkedBankId = await findBankId(svc, em.user_id, bankSlug);

    if (!linkedBankId && (links as any).linked_bank_id) linkedBankId = (links as any).linked_bank_id;

    if (parsed.kind === "statement") {
      const { data: newStatement, error: se } = await svc.from("statements").insert({
        user_id: em.user_id,
        statement_type: parsed.statement_type,
        statement_date: parsed.statement_date,
        period_start: parsed.period_start,
        period_end: parsed.period_end,
        source_email_id: em.id,
        credit_card_id: links.credit_card_id ?? null,
        financial_account_id: links.financial_account_id ?? null,
        loan_id: links.loan_id ?? null,
        linked_bank_id: linkedBankId,
        source: "email",
        confidence: parsed.confidence,
        parse_error: links.credit_card_id || links.financial_account_id || links.loan_id ? null : "unlinked_no_entity_match",
      }).select("id").single();
      if (!se && newStatement) {
        statements++;
        await ingestStatementAttachment(svc, account, em, newStatement.id, links, {
          statement_type: parsed.statement_type,
          bank_slug: bankSlug,
        });
      } else if (se && !String(se.message).includes("duplicate")) {
        console.warn("statement insert", se.message);
      }
    } else {
      const { error: te } = await svc.from("transactions").insert({
        user_id: em.user_id,
        txn_date: parsed.txn_date,
        amount: parsed.amount,
        txn_type: parsed.txn_type,
        merchant: parsed.merchant,
        category: parsed.category,
        reference_number: parsed.reference_number,
        source: "email",
        source_email_id: em.id,
        confidence_score: parsed.confidence,
        financial_account_id: links.financial_account_id ?? null,
        credit_card_id: links.credit_card_id ?? null,
        loan_id: links.loan_id ?? null,
      });
      if (!te) transactions++;
      else if (!String(te.message).includes("duplicate")) console.warn("txn insert", te.message);
    }

    // Enrich the source email with bank/card links.
    if (links.linked_bank_id || links.linked_card_id) {
      await svc.from("emails").update({
        linked_bank_id: links.linked_bank_id ?? null,
        linked_card_id: links.linked_card_id ?? null,
      }).eq("id", em.id);
    }
  }

  return { scanned: candidates?.length ?? 0, transactions, statements, skipped };
}
