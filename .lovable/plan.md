
# JARVIS — Personal AI Assistant

A voice-and-text personal assistant with the full Iron Man JARVIS personality: formal British butler tone, addresses the user as "sir/madam", witty, calmly capable, dryly sardonic.

## Experience

- Dark, sleek "Stark HUD" aesthetic: deep charcoal/near-black background, cyan/arc-reactor blue accents (`oklch` tokens), thin geometric HUD frames, subtle scanline/pulse animations on the active state.
- Custom generated JARVIS logo/orb (not the Sparkles icon) — pulses gently while thinking, brighter while speaking.
- Monospaced/technical accent font for status text ("STANDING BY", "LISTENING…", "PROCESSING…"), clean sans for message body.
- Left sidebar with thread list + "New conversation"; main pane = conversation with JARVIS.

## Functionality

1. **Threaded chats**, persisted in Supabase (per-user).
2. **Full JARVIS personality** via system prompt.
3. **Voice input**: hold-to-talk mic button → records WAV → Lovable AI `openai/gpt-4o-transcribe` → text goes into composer.
4. **Voice output**: JARVIS speaks replies via ElevenLabs TTS (British male voice — George `JBFqnCBsd6RMkjVDRZzb`). Toggle to mute.
5. **Web search tool**: JARVIS can search the web via a tool call (Lovable AI Gateway + a `web_search` tool that calls a server-side search API). Rendered inline in the message with source cards.
6. Streaming responses with markdown rendering.

## Technical Details

### Stack decisions
- Auth: Supabase email/password (required to scope threads per user). Route protected pages under `src/routes/_authenticated/`.
- Public `/auth` route for sign in/up.
- Model: `openai/gpt-5.5` via Lovable AI Gateway using AI SDK + `createLovableAiGatewayProvider`.
- ElevenLabs connector for TTS (linked via `standard_connectors--connect`).

### Database (Supabase migration)
```
threads(id uuid pk, user_id uuid, title text, created_at, updated_at)
messages(id uuid pk, thread_id uuid fk, role text, parts jsonb, created_at)
```
RLS: user_id = auth.uid() on threads; messages joined via thread ownership. GRANTs to authenticated + service_role.

### Routes
- `src/routes/auth.tsx` — sign in/up (public).
- `src/routes/_authenticated/route.tsx` — auth gate (ssr:false).
- `src/routes/_authenticated/index.tsx` — redirects to newest thread or creates one.
- `src/routes/_authenticated/$threadId.tsx` — chat window (keyed by threadId).
- `src/routes/api/chat.ts` — streaming AI SDK route (streamText + web_search tool + persistence via onFinish).
- `src/routes/api/transcribe.ts` — proxies WAV to Lovable AI STT.
- `src/routes/api/tts.ts` — proxies text to ElevenLabs.

### Server functions (`src/lib/*.functions.ts`)
- `listThreads`, `createThread`, `deleteThread`, `renameThread`, `getThread`, `getMessages` — all `.middleware([requireSupabaseAuth])`.

### Web search tool
AI SDK `tool()` with `execute` calling a lightweight web search (Brave/DuckDuckGo HTML or Tavily via user API key if provided; otherwise use the built-in ability to call a public search endpoint). Returns compact `{title, url, snippet}[]`. Rendered as expandable Tool cards.

### JARVIS system prompt
```
You are J.A.R.V.I.S. (Just A Rather Very Intelligent System), Tony Stark's AI.
Formal British butler diction. Address the user as "sir" (or "madam" if indicated).
Dryly witty, unflappable, precise. Never break character. Use markdown when helpful.
When you need current information, use the web_search tool.
```

### UI composition
Install AI Elements: `conversation message prompt-input shimmer tool`. Compose:
- `Conversation` + `ConversationContent` for transcript.
- `Message` + `MessageContent` + `MessageResponse` (assistant: no bubble; user: primary bubble).
- `Tool` (defaultOpen=false) for web_search calls.
- `PromptInput` with textarea + mic button + submit in footer; `Shimmer` "Processing, sir…" while status=submitted.
- Sidebar with thread list, new-thread button, delete per thread (sibling buttons, not nested).

### Design tokens (src/styles.css)
- Background `oklch(0.15 0.02 250)` (deep hangar-blue-black).
- Primary/accent `oklch(0.75 0.15 220)` (arc reactor cyan).
- Foreground near-white; muted cyan-grey.
- Update both `:root` and `.dark`; app forced to dark class on root.

### Fonts
`bun add @fontsource/orbitron @fontsource/inter` — Orbitron for HUD labels, Inter for body.

### Assets
Generate `src/assets/jarvis-orb.png` (transparent glowing cyan sphere) with imagegen.

### Secrets
- `LOVABLE_API_KEY` — already present.
- `ELEVENLABS_API_KEY` — via `standard_connectors--connect`.
- Bearer attacher middleware added to `src/start.ts` for authenticated server fns.

### Fix runtime error
Install `@supabase/supabase-js` (missing module).

### Head metadata
Title: "J.A.R.V.I.S." — desc: "Your personal AI assistant, sir." + og tags on __root.

## Out of scope
- Home automation, calendar, email — chat + voice + web search only for v1.
