---
name: research
description: Research a topic on the web and save a structured report to Resources. Use when Deepak says "research X", "look into X", or "compare X and Y".
---

Argument: the topic. If missing, ask what to research and how deep (quick scan vs. thorough).

1. Check `Resources/` for existing material on the topic — build on it, don't duplicate.
2. For a deep dive, delegate to the `researcher` agent; for a quick scan, use WebSearch/WebFetch directly (3–5 sources).
3. Write the report to `Resources/<topic-kebab>/YYYY-MM-DD-<slug>.md`: **TL;DR** (3 bullets max), findings, comparison table if comparing, sources as links, open questions.
4. Answer Deepak's actual question in chat — the TL;DR first, file link included — and log one line in today's log.
