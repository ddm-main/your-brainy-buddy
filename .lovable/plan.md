
# JARVIS Build Plan — 3 sequential approvals

You picked **Do all three in order** and **Reuse existing HUD**. I'll execute as three separate approval gates so you can course-correct between each. This plan covers **Step 1 only** — the PRD doc. Steps 2 and 3 will come back as their own plans after you approve each preceding one.

## Step 1 (this plan) — Write the PRD

Create the blueprint as a real doc inside the OS, following your file rules (`Projects/<name>/_overview.md`, kebab-case, ISO dates, files-are-state).

**Files created:**

```text
Projects/jarvis/
  _overview.md          # outcome, status, next actions (per your Projects rule)
  PRD.md                # full product requirements — the blueprint, cleaned up
  architecture.md       # 6 pillars + module map + information architecture
  data-model.md         # entity list + relationships (prose, no SQL yet — SQL is Step 2)
  roadmap.md            # Phase 1 → 4, MVP scope, v1 success criteria
  homepage-spec.md      # HUD layout mapped onto the existing shell (JarvisCore, HudPanel, VoiceBar)
```

**PRD.md structure** (mirrors your blueprint, tightened):
1. Vision & product identity
2. The 6 pillars
3. Module-by-module spec (Home/HUD, Chat, Tasks, Inbox, Finance, Projects, Memory, Goals, Automations, Reports, Settings)
4. JARVIS intelligence model (what it knows / watches / does)
5. Cross-module entity model (people, vendors, banks, cards, projects, tools)
6. Non-goals for v1

**homepage-spec.md** explicitly maps blueprint sections onto files that already exist so nothing is thrown away:

```text
Left column  → HudPanel "Today's Focus" + Quick Actions + Daily Brief
Center       → JarvisCore (cyan neural brain, kept) + VoiceBar + active intelligence strip
Right column → Inbox summary + Finance summary + Work summary panels
Bottom       → Tasks, Projects, Recent decisions, Automations, Recent JARVIS actions
```

**Log & dashboard hygiene** (per your operating rules):
- Append one line to `System/Logs/2026-07-09.md`: "created Projects/jarvis PRD pack"
- Update `Dashboard.md` — add `jarvis` to Active Projects with next action "approve Step 2 schema plan"
- Add a `System/Memory/` entry only if a durable decision emerges while writing (won't invent one)

**Nothing else changes.** No code, no schema, no HUD edits in this step.

## Step 2 (next plan, after you approve Step 1) — Supabase schema

I'll return with a migration plan covering the v1 tables from your blueprint: core (profiles, settings, tags, entities), productivity (tasks, notes, decisions, projects, incidents, vendors, renewals), inbox (email_accounts, emails, attachments), finance (banks, financial_accounts, credit_cards, loans, financial_goals, subscriptions, transactions, statements, finance_email_rules, reconciliation_matches), automation logs. Each `CREATE TABLE` will include GRANTs + RLS + policies in the same migration. You approve the SQL before it runs.

## Step 3 (next plan, after you approve Step 2) — Phase 1 MVP build

Wire the existing HUD shell to the new schema: Tasks, Notes, Inbox basic, Finance structure screens, Projects, and a working command bar on top of `VoiceBar` + `CommandPalette`. Reuses `JarvisCore`, `HudPanel`, existing routes. File-level change list will be in that plan.

## Out of scope right now

- Any code edits, package installs, or design changes to the current cyan brain HUD
- Statement parsing, reconciliation engine, voice execution, automations — those are Phase 2–4
- Email/OAuth provider wiring — that comes with Inbox module in Step 3

Approve to write the PRD pack.
