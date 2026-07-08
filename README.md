# JARVIS — Personal Agentic OS

A file-based operating system for your life, with Claude Code as the kernel. Everything JARVIS knows and does lives in plain markdown files in this folder — durable, portable, and inspectable.

## How it works

```
E:\Claude\JARVIS
├── CLAUDE.md            ← the kernel: JARVIS identity + operating rules (loaded every session)
├── Dashboard.md         ← one-screen state of everything
├── Inbox/               ← capture anything; processed to zero by /inbox
├── Projects/            ← active efforts with an outcome (one folder each)
├── Areas/               ← ongoing life domains: Health, Finance, Career, Learning, Personal
├── Resources/           ← reference material & research reports
├── Archive/             ← finished/dead stuff (moved, never deleted)
├── System/
│   ├── Memory/          ← what JARVIS knows about you (MEMORY.md is the index)
│   ├── Logs/            ← daily notes, one file per day
│   └── Protocols/       ← how rituals like the briefing and weekly review work
├── Apps/
│   └── hud/             ← JARVIS HUD: live web dashboard on the Supabase backend
└── .claude/
    ├── skills/          ← slash commands (below)
    └── agents/          ← specialist subagents: researcher, writer, organizer
```

## The HUD

A zero-dependency web dashboard (inspired by [agentic-os-personal](https://github.com/vivekmishraishere/agentic-os-personal)) showing focus, projects, inbox, areas, memory, and logs live from Supabase:

```powershell
node Apps/hud/server.mjs     # → http://localhost:3960
```

Credentials come from `Apps/hud/.env` (gitignored; see `.env.example`). Data refreshes every 30s — run `/sync` after working in the OS to update what it shows.

## Daily use

Open Claude Code in this folder and just talk. Or use the commands:

| Command | What it does |
|---------|--------------|
| `/brief` | Morning briefing: focus, open loops, inbox count, one suggestion |
| `/plan` | Pick 1–3 priorities for the day or week |
| `/inbox` | Process captured items to zero |
| `/new-project <idea>` | Spin up a project folder with outcome + next actions |
| `/research <topic>` | Web research → structured report in Resources |
| `/journal` | End-of-day reflection into the daily log |
| `/review` | Weekly review: sweep projects, pulse areas, set priorities |
| `/remember <fact>` | Save something durable to memory |
| `/dashboard` | Rebuild Dashboard.md from ground truth |

Anything you type that's just a thought/link/task gets captured to the Inbox automatically.

## First steps

1. Run `/brief` — JARVIS will notice the profile is empty and interview you.
2. Tell it about yourself, or edit `System/Memory/profile.md` directly.
3. Create your first project with `/new-project`.
4. Optional: ask JARVIS to set up a scheduled morning briefing (`/schedule` in Claude Code), and `git init` this folder for versioned history of your life OS.

## Design principles

- **Files are the state.** If it's not in a file, it doesn't exist next session.
- **PARA** (Projects / Areas / Resources / Archive) keeps everything findable.
- **Memory compounds.** Every session, JARVIS reads memory first and writes back what it learned.
- **Move, never delete.**
