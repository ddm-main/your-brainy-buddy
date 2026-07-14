# Security protocol

Single-user personal OS. Posture accepted in `security-memory`. This file lists user actions the agent cannot perform.

## Enable Leaked-Password Protection (one-time, user action)

Have I Been Pwned check on sign-up + password change. Off by default on this project.

1. Open **Cloud → Users → Auth Settings** (gear icon).
2. **Email settings** → toggle **Password HIBP Check** on.
3. Save.

No code change required. The Supabase linter warning `auth_leaked_password_protection` closes once the toggle is on.

## Storage buckets (2026-07-12)

- Project currently reports **0 buckets**. Statement upload path in code references `statement-pdfs` — will be created in Phase 2 (P2-1) alongside the parse-retry flow. Bucket must be **private**, RLS `bucket_id = 'statement-pdfs' AND name LIKE auth.uid() || '/%'` (single-user posture: policy still enforced so the pattern is correct when auth lands).

## Rotation checklist (quarterly)

- `LOVABLE_API_KEY` — rotate via `ai_gateway--rotate_lovable_api_key`.
- Statement encryption key (`STATEMENT_PASSWORD_SECRET` in edge fn env) — rotate + re-encrypt existing rows; migration script TODO.
- Google OAuth client secret — rotate in Google Cloud console, update `GMAIL_OAUTH_CLIENT_SECRET`, reconnect mailboxes.

## Never expose to client

Database URLs · project IDs · storage paths · SQL errors · stack traces · access/refresh tokens · service-role key · edge-fn URLs beyond the invoke helper.

All user-facing errors must pass through `src/lib/userError.ts::toUserError`.
