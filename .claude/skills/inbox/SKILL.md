---
name: inbox
description: Process the inbox to zero — route each captured item to a project, area, resource, memory, or task. Use when Deepak says "process my inbox" or the inbox is piling up.
---

Empty `Inbox/inbox.md` by routing every unchecked item:

1. Read `Inbox/inbox.md`. If empty, say so and stop.
2. For each item, decide: **actionable task** → add as next action to the right `Projects/<name>/_overview.md` (or ask if it warrants a new project); **reference** → file under `Resources/<topic>/`; **fact about Deepak** → save to `System/Memory/`; **someday/maybe** → `Resources/someday.md`; **trash** → propose dropping it (confirm before removing).
3. Batch obvious routings without asking; ask only about genuinely ambiguous items — present those as one grouped question at the end, not one by one.
4. Rewrite `Inbox/inbox.md` back to its empty template, update `Dashboard.md` inbox count, and log a one-liner ("processed N inbox items") in today's log.
5. Report: N items → where they went, one line each.
