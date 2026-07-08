---
name: dashboard
description: Regenerate Dashboard.md from the actual state of projects, areas, inbox, and logs. Use when Deepak asks for "status", "dashboard", or after big changes.
---

Rebuild `Dashboard.md` from ground truth — never from its own previous contents:

1. **Projects table**: every `Projects/*/_overview.md` → name, status, top unchecked next action. Flag any project with no next action or untouched >14 days as ⚠️ stale.
2. **Areas table**: one-line health per `Areas/*/_overview.md` (or "not yet reviewed").
3. **Inbox count**: unchecked items in `Inbox/inbox.md`.
4. **Today's focus**: from today's log if set.
5. **Open loops**: waiting-ons and stale items found during the sweep.

Keep it to one screen. Update the "Last updated" date. Show the result in chat.
