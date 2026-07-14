# JARVIS — Product Requirements

> Personal AI second brain + work OS + finance OS + inbox OS + action engine.
> Single promise: *"One system that knows my work, money, emails, tasks, notes, projects, and routines — and helps me remember, decide, and act."*

## 1. Vision & identity

JARVIS is a **personal AI operating system**, not a chatbot. It does four things at once:

1. **Remembers for you** — notes, projects, finance, emails, decisions, routines, goals, SOPs.
2. **Thinks with context** — knows which email belongs to which bank/project/person, what's urgent, what changed.
3. **Acts for you** — scans finance mails, drafts replies, creates tasks, reconciles transactions, triggers reminders.
4. **Guides you** — proactive: what needs attention, what's forgotten, what's off-track.

**Voice:** calm, competent, concise, lightly witty. Addresses Deepak by name.

## 2. The 6 pillars

1. **Command Center** — "what should I focus on now?"
2. **Memory Brain** — durable knowledge: notes, decisions, SOPs, references, vendor details.
3. **Inbox / Communication OS** — multi-account inbox with summaries, follow-up detection, finance extraction.
4. **Finance OS** — banks, cards, loans, goals, subscriptions, transactions, statements, reconciliation.
5. **Work / Projects / IT OS** — projects, incidents, procurement, vendors, renewals, assets.
6. **Action / Agent Layer** — understands commands (text/voice), executes across modules, runs workflows.

## 3. Modules

### 3.1 Home / HUD (Command Center)
Answers: *what to do today · what's urgent · what's pending · what changed · what am I forgetting.*
Widgets: Today's Focus, JARVIS AI Core (voice/command), Inbox summary, Finance summary, Card/EMI dues, Project blockers, Follow-ups, Daily brief, Quick actions, Active intelligence strip, Recent JARVIS actions.

### 3.2 JARVIS Chat / Voice / Command
Modes: text, voice, quick launcher, slash commands, contextual actions from widgets.
States: idle, listening, thinking, speaking, executing, success, error.
Command categories: search/recall, create/update, inbox actions, finance actions, work actions.

### 3.3 Tasks / Planner / Follow-up Engine
Entities: Task, Reminder, Follow-up, Recurring task, Checklist.
Fields: title, description, status, priority, due_at, reminder_at, recurrence, tags, links (project/email/account/goal), owner, source.
Views: Today, Upcoming, Overdue, Waiting on others, Recurring, Personal, Work, Finance-related, By project.
Smart: create task from email/meeting note, follow-up if no reply in X days, daily focus list.

### 3.4 Inbox / Communication OS
Multi-account. Sections: Important, Needs Reply, Follow-up, Finance, Work, Personal.
Actions: read, archive, reply, draft, summarize thread, mark as task, set reminder, categorize, extract attachment, link to project/account/vendor.
Finance-specific: sender→bank/card/loan mapping, subject patterns, daily txn alerts vs monthly statements, OTP/bill/EMI detection, finance-only scan mode.

### 3.5 Finance OS
Submodules: Accounts, Credit Cards, Transactions, Statements, Loans, Financial Goals, Bills/Subscriptions, Reports, Reconciliation Center, Finance Inbox Rules.

- **Accounts:** bank, nickname, type, masked number, statement cycle, source email, notes, linked loans/goals.
- **Cards:** bank, name, last-4, billing/due day, limit, autopay, statement email mapping, password rule.
- **Transactions:** date, amount, type, merchant, category, account/card/loan, source (email/statement/manual), reference, confidence, duplicate group.
- **Statements:** type, account/card/loan, period, source email, file, parse status, txns found, reconciliation status.
- **Reconciliation:** match statement txns against daily-alert txns by amount+date+account+merchant/ref; confidence tiers high/medium/low; review queue.
- **Loans:** lender, type, principal, rate, EMI, tenure, start, outstanding, next due, prepayment log, projections.
- **Goals:** target amount/date, linked account, monthly contribution, progress, off-track alerts.
- **Bills/Subscriptions:** name, category, amount, cycle, next due, payment method, source email.

### 3.6 Projects / Work OS
Submodules: Projects, Incidents/Issues, Procurement, Vendors, Renewals/Subscriptions, Assets/Infra, Approvals/Follow-ups.
Project fields: name, description, status, priority, dates, owner, linked tasks/notes/emails/vendors, blockers, next action, last update.

### 3.7 Memory Vault
Note types: general, project, meeting, SOP, decision, reference, personal, finance.
Capabilities: AI summary, related-note linking, tag search, entity linking (person/bank/project/tool/vendor), voice note → transcript → auto-categorize.
**Decision log:** title, date, context, options considered, final decision, rationale, links.

### 3.8 Goals
Types: finance, health, learning, family, travel, purchase, work, habits.

### 3.9 Automations / Agent Workflows
Finance: daily email scan, monthly statement scan, due reminders, missing statement alerts, unusual spend.
Inbox: morning important-mail summary, no-reply reminders, statement PDF extraction, email→task.
Work: weekly project summary, renewal reminders, vendor follow-ups, escalations.
Personal: bill/birthday/workout/learning reminders.

### 3.10 Reports / Insights / Reviews
Daily brief, evening wrap-up, weekly review, monthly finance report.

### 3.11 Admin / Settings / Integrations
Email accounts, finance email rules, statement password rules, categories, tags, JARVIS preferences, notification prefs.

## 4. JARVIS intelligence model — what it knows

- **Personal:** routines, goals, family reminders, habits, preferred ways of working.
- **Work:** projects, vendors, tools, recurring IT tasks, office issues, renewal schedules, contacts.
- **Finance:** banks, cards, statement timing, due dates, loans/EMIs, goals, subscriptions, statement password rules.
- **Communication:** which email is for what, frequent-follow-up senders, ongoing threads, finance/project sender maps.

## 5. What JARVIS watches / does automatically

- Unread important emails, statement arrivals, card/EMI due dates, renewals, follow-up deadlines, overdue tasks, project blockers, spending anomalies, missing monthly statements.
- Generates daily brief, scans finance emails daily, reminds for dues, creates follow-ups, summarizes unread mails, surfaces overdue tasks, flags missing finance data, generates weekly review.

## 6. Non-goals for v1

- Real bank/UPI API integrations (email-first).
- Full accounting/tax engine.
- Multi-user / team collaboration.
- Mobile-native apps (HUD is browser-first, responsive).
- Executing outbound sends (email/SMS) without explicit confirmation.

## 7. v1 success criteria

You know it works if you can reliably:
1. Open JARVIS and see today's priorities instantly.
2. Ask "what should I do today?" and get a useful answer.
3. See important emails + tasks in one place.
4. Track all accounts / cards / loans / subscriptions in one place.
5. Save project notes / decisions and retrieve them.
6. See upcoming finance dues without checking multiple places.
7. Create reminders and recurring follow-ups easily.
8. Track active projects and blockers.
9. Search across notes / tasks / finance / projects from one command bar.
10. Get a daily brief without manually collecting info.
11. Store finance and work context in a structured way.
12. Use JARVIS as the first place to check *"what's happening"*.
