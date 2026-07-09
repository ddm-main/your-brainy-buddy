# JARVIS — Architecture

## Top-level app modules

```text
Home / HUD
JARVIS Chat / Voice
Tasks & Planner
Inbox
Finance
Projects / Work OS
Memory Vault
Goals
Automations
Reports / Insights
Admin / Settings / Integrations
```

## Layered view

```text
┌──────────────────────────────────────────────────────────────┐
│  Presentation (HUD)  — React + Vite, existing shell          │
│  JarvisCore · HudPanel · VoiceBar · CommandPalette · Routes  │
├──────────────────────────────────────────────────────────────┤
│  Agent / Command Layer                                       │
│  Intent routing, tool calls, voice state, workflow runner    │
├──────────────────────────────────────────────────────────────┤
│  Domain services                                             │
│  Tasks · Notes · Inbox · Finance · Projects · Memory · Goals │
├──────────────────────────────────────────────────────────────┤
│  Persistence — Supabase (Lovable Cloud)                      │
│  Postgres + RLS · Edge Functions · Storage (attachments)     │
├──────────────────────────────────────────────────────────────┤
│  Ingestion (Phase 2+)                                        │
│  Email fetch · Statement PDF parse · Reconciliation engine   │
└──────────────────────────────────────────────────────────────┘
```

## Cross-module entity model

A shared `entities` concept lets modules link to the same real-world thing:

- **person** — colleagues, family, vendors' contacts
- **vendor** — companies / suppliers
- **bank** — banking institutions
- **card / account / loan** — specific finance instruments (own tables, but referenced as entities)
- **project** — active efforts
- **tool / subscription** — SaaS or services
- **place** — office, home, sites

Any note, task, email, transaction, or decision can link to one or more entities. This is what makes cross-module recall work ("show everything about HDFC", "what did I decide about Synology NAS").

## HUD composition (reuses existing shell)

```text
src/routes/Home.tsx
  ├─ TopBar
  ├─ HUD grid
  │   ├─ Left column   : Today's Focus · Quick Actions · Daily Brief
  │   ├─ Center        : JarvisCore (cyan neural brain) · Active intel · VoiceBar
  │   └─ Right column  : Inbox summary · Finance summary · Work summary
  ├─ Bottom row        : Tasks · Projects · Recent decisions · Automations · Recent JARVIS actions
  └─ CommandPalette (⌘K)
```

## Backend surface (target for Step 2/3)

- Supabase tables (see `data-model.md`).
- Edge functions: `jarvis-chat`, `jarvis-command`, `finance-scan`, `inbox-scan`, `statement-parse`, `reconcile`, `daily-brief`.
- Storage bucket: `attachments` (email attachments, statement PDFs).
- Scheduled jobs (pg_cron): daily finance scan, morning brief, weekly review.
