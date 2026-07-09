# JARVIS — Homepage / HUD Spec (mapped to existing shell)

Reuses: `src/routes/Home.tsx`, `src/components/core/JarvisCore.tsx` (cyan neural brain, keep), `src/components/hud/HudPanel.tsx`, `src/components/hud/VoiceBar.tsx`, `src/components/hud/CommandPalette.tsx`, `src/components/hud/TopBar.tsx`, `src/components/hud/ToastLayer.tsx`.

## Layout

```text
┌─────────────────────────── TopBar (existing) ──────────────────────────┐
│                                                                        │
│  ┌──────── LEFT ────────┐  ┌────── CENTER ──────┐  ┌───── RIGHT ─────┐ │
│  │ 01 Today's Focus     │  │ CORE J.A.R.V.I.S    │  │ 04 Inbox Pulse  │ │
│  │ 02 Daily Brief       │  │  · JarvisCore       │  │ 05 Finance      │ │
│  │ 03 Alerts / Follow-up│  │    (cyan neural)    │  │ 06 Work / IT    │ │
│  │    Quick Actions     │  │  · Active Intel     │  │                 │ │
│  │                      │  │  · KineticNumber    │  │                 │ │
│  └──────────────────────┘  └────────────────────┘  └─────────────────┘ │
│                                                                        │
│  ┌───────────────────── BOTTOM (activity strip) ──────────────────────┐│
│  │ 07 Tasks · Projects · Decisions · Automations · Recent Actions     ││
│  └────────────────────────────────────────────────────────────────────┘│
│                                                                        │
│  VoiceBar (bottom-fixed) · CommandPalette (⌘K modal) · ToastLayer      │
└────────────────────────────────────────────────────────────────────────┘
```

## Panel-by-panel

### Left column
- **01 Today's Focus** — top 3–7 priorities pulled from `tasks` (due today, high priority, marked focus).
- **02 Daily Brief** — output of `daily-brief` edge function; what changed, upcoming, urgent.
- **03 Alerts & Follow-ups** — overdue tasks, finance dues in 48h, blocked projects, follow-ups past SLA.
- **Quick Actions** — Add task, Add note, Scan finance mails, Open inbox, Ask JARVIS.

### Center
- **JarvisCore** — kept as-is (cyan neural network). Tint reacts to voice/agent state.
- **Active Intel strip** (over/under JarvisCore) — one-liners: "3 important unread", "2 card dues this week", "1 project blocked", "HDFC statement not received".
- **VoiceBar** — text + voice input, current state (idle/listening/thinking/speaking/executing).

### Right column
- **04 Inbox Pulse** — counts (unread/important/needs-reply) + top 3 threads.
- **05 Finance** — net position, upcoming dues, month spend, small sparkline, last scan status.
- **06 Work / IT** — active projects, blockers, renewals in next 14 days, open incidents.

### Bottom
- **07 Tasks / Projects / Decisions / Automations / Recent JARVIS actions** — dense horizontal strip; scannable, click-through to full routes.

## State reactivity

| Voice state | JarvisCore behavior | HUD behavior |
|---|---|---|
| idle | slow pulse, cyan | panels normal |
| listening | node pulses up to 30/s | VoiceBar amplitude ring active |
| thinking | rotation 2×, `HOT` tint | Active Intel shows "thinking…" |
| speaking | pulses sync to amplitude | subtitle line under JarvisCore |
| executing | brief flash + rotation | toast for action, `jarvis_actions` row |
| success/error | color glint | toast |

## Routes touched (Phase 1)

- `/` — HUD (this spec)
- `/inbox` — full inbox
- `/finance` — full finance dashboard + subroutes
- `/projects` — projects list + detail
- `/settings` — accounts, rules, prefs

Existing routes already scaffolded: `src/routes/Home.tsx`, `src/routes/Inbox.tsx`, `src/routes/Finance.tsx`, `src/routes/Projects.tsx`, `src/routes/Settings.tsx`. Phase 1 wires them to real Supabase data.

## Non-changes in Step 1
No code edits. JarvisCore stays cyan neural brain. This spec is the contract Step 3 implements against.
