# JARVIS — Roadmap

## Phase 1 — Foundation (MVP)
Goal: useful daily.

- Home / HUD basic layout (reuse current shell)
- JARVIS command bar + text chat
- Tasks + reminders
- Notes / Memory Vault
- Inbox integration (basic list + link one account)
- Finance structure: banks, accounts, cards, loans, goals, subscriptions
- Manual finance transaction entry
- Daily brief widget
- Universal search across tasks + notes + projects + finance
- Projects basic module

**Exit criteria:** all 12 v1 success items (see `PRD.md` §7) pass.

## Phase 2 — Intelligence Layer
Goal: feels like a second brain.

- Email classification + AI summaries
- Finance email rules + finance-only scanner
- Statement attachment extraction
- Transaction ingestion from daily-alert emails
- Follow-up detection in inbox
- Memory linking / related notes
- Daily + weekly review engine
- Project summary generation

## Phase 3 — Finance OS + Reconciliation
Goal: finance is powerful and accurate.

- Statement PDF parser pipeline
- Statement password rule engine
- Reconciliation engine + duplicate detection
- Reconciliation review UI
- Monthly finance reports
- Category learning / correction workflow
- EMI / loan / goal intelligence
- Unusual spend alerts

## Phase 4 — Full Agent / Automation Layer
Goal: JARVIS becomes an operator.

- Voice interaction (full loop)
- Action execution across modules
- Scheduled automations
- Cross-module command execution
- App-to-app workflows
- Proactive alerts / suggestions

## MVP scope (locked)

**Modules:** Home/HUD · Tasks/Reminders · Notes/Memory · Inbox basic + AI summary · Finance structure · Loans + Goals + Subscriptions · Projects basic · JARVIS command/search bar.

**Must-have flows:**
- create task / reminder
- save note / decision
- view finance accounts / cards / loans / goals
- add manual transaction
- view important emails
- ask JARVIS for summaries
- see today's focus

## Build stream split (for later prompt packaging)

1. **Core app shell** — nav, HUD, command bar, tasks, notes, settings.
2. **Finance OS** — banks/accounts/cards/loans/goals/subs + dashboard + txn/statement models.
3. **Inbox OS** — accounts, views, AI summary UI, finance tagging, thread actions.
4. **Work OS** — projects, incidents, vendors, renewals, procurement.
