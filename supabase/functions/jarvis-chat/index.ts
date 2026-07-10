import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  tool,
  type UIMessage,
} from "npm:ai";
import { z } from "npm:zod";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createOpenAICompatible } from "npm:@ai-sdk/openai-compatible";
import { createLovableAiGatewayProvider } from "../_shared/ai-gateway.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SYSTEM_PROMPT = `You are JARVIS, Deepak's personal AI operating system.
Voice: calm, competent, concise, lightly witty — Iron Man's JARVIS, not a corporate chatbot.
Address him as "Deepak" or "sir" (sparingly) in English. If he speaks another language, mirror it and use the appropriate honorific.
Keep spoken replies to 1-3 sentences unless he asks for detail.
For time-sensitive facts (news, prices, weather, flights) call the appropriate tool — never fabricate.
When you need to see his screen or camera, call look_at_screen / look_at_camera and briefly say "Looking now, sir." while it captures.`;

// --- DuckDuckGo lite HTML search (no key) ------------------------------------

async function ddgSearch(query: string, mode: "search" | "news"): Promise<
  Array<{ title: string; url: string; snippet: string; source: string; publishedAt?: string }>
> {
  const endpoint = mode === "news"
    ? `https://duckduckgo.com/html/?q=${encodeURIComponent(query + " site:news")}&iar=news&ia=news`
    : `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(endpoint, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    },
  });
  const html = await res.text();
  const out: ReturnType<typeof ddgSearch> extends Promise<infer T> ? T : never = [];
  const resultRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = resultRe.exec(html)) && out.length < 8) {
    const rawUrl = m[1].replace(/&amp;/g, "&");
    // ddg wraps outbound links in /l/?uddg=<encoded>
    let url = rawUrl;
    const wrapped = rawUrl.match(/[?&]uddg=([^&]+)/);
    if (wrapped) url = decodeURIComponent(wrapped[1]);
    const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const title = strip(m[2]);
    const snippet = strip(m[3]);
    let source = "";
    try {
      source = new URL(url).hostname.replace(/^www\./, "");
    } catch { /* noop */ }
    if (title && url) out.push({ title, url, snippet, source });
  }
  return out;
}

// --- Open-Meteo weather ------------------------------------------------------

async function geocode(city: string): Promise<{ lat: number; lng: number; label: string } | null> {
  const r = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
  );
  const j = await r.json();
  const hit = j?.results?.[0];
  if (!hit) return null;
  return {
    lat: hit.latitude,
    lng: hit.longitude,
    label: `${hit.name}${hit.admin1 ? ", " + hit.admin1 : ""}${hit.country ? ", " + hit.country : ""}`,
  };
}

async function fetchWeather(lat: number, lng: number) {
  const r = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code` +
      `&hourly=temperature_2m,precipitation_probability,weather_code&forecast_hours=24`,
  );
  return r.json();
}

// --- Supabase (service role) for memory + reminders --------------------------

function admin() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

// -----------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) {
    return new Response(JSON.stringify({ error: "LOVABLE_API_KEY not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json() as {
      messages: UIMessage[];
      provider?: "gemini" | "openrouter";
      model?: string;
      screenshotUrl?: string;
      mode?: string;
    };
    const { messages, provider = "gemini", model: requestedModel, screenshotUrl } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const gateway = createLovableAiGatewayProvider(key);

    // Provider routing.
    let modelInstance: any;
    if (provider === "openrouter") {
      const orKey = Deno.env.get("OPENROUTER_API_KEY");
      if (!orKey) {
        return new Response(
          JSON.stringify({
            error: "OPENROUTER_API_KEY not configured. Add it in project secrets to use OpenRouter models.",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const openrouter = createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        headers: {
          Authorization: `Bearer ${orKey}`,
          "HTTP-Referer": "https://jarvis.lovable.app",
          "X-Title": "JARVIS",
        },
      });
      modelInstance = openrouter(requestedModel ?? "openai/gpt-5");
    } else {
      modelInstance = gateway(requestedModel ?? "google/gemini-3-flash-preview");
    }

    // If a screenshot is attached, inject it as an image on the latest user turn.
    if (screenshotUrl) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (lastUser) {
        const parts = (lastUser as any).parts ?? [];
        parts.push({ type: "image", image: screenshotUrl });
        (lastUser as any).parts = parts;
      }
    }

    const tools = {
      web_search: tool({
        description:
          "Search the live web for time-sensitive info. Use for news, prices, current events, product research, comparisons. Returns article/page results.",
        inputSchema: z.object({
          query: z.string().describe("Search query in natural language"),
          mode: z
            .enum(["search", "news", "research", "price", "compare"])
            .default("search")
            .describe("Search flavor. news = latest articles; research = broader; price/compare = product oriented."),
        }),
        execute: async ({ query, mode }) => {
          const kind = mode === "news" ? "news" : "search";
          const results = await ddgSearch(query, kind);
          return { mode, query, results };
        },
      }),
      weather: tool({
        description: "Current conditions and next 24h forecast for a city.",
        inputSchema: z.object({
          location: z.string().describe("City name, e.g. 'Mumbai' or 'Bengaluru, India'"),
        }),
        execute: async ({ location }) => {
          const g = await geocode(location);
          if (!g) return { error: `Could not find location "${location}"` };
          const w = await fetchWeather(g.lat, g.lng);
          return {
            location: g.label,
            current: w.current,
            hourly_next_24h: {
              time: w.hourly?.time?.slice(0, 24),
              temperature: w.hourly?.temperature_2m?.slice(0, 24),
              precipitation_probability: w.hourly?.precipitation_probability?.slice(0, 24),
              weather_code: w.hourly?.weather_code?.slice(0, 24),
            },
          };
        },
      }),
      remember: tool({
        description: "Store or update a durable fact about Deepak, his preferences, people, or decisions.",
        inputSchema: z.object({
          topic: z.string().describe("Short topic key, e.g. 'preferences.language' or 'people.rahul'"),
          content: z.string().describe("The fact to remember, in natural language"),
          tags: z.array(z.string()).default([]),
        }),
        execute: async ({ topic, content, tags }) => {
          const db = admin();
          const existing = await db
            .from("jarvis_memory")
            .select("id")
            .eq("topic", topic)
            .maybeSingle();
          if (existing.data?.id) {
            const { error } = await db
              .from("jarvis_memory")
              .update({ content, tags, updated_at: new Date().toISOString() })
              .eq("id", existing.data.id);
            if (error) return { error: error.message };
            return { updated: true, topic };
          }
          const { error } = await db.from("jarvis_memory").insert({ topic, content, tags });
          if (error) return { error: error.message };
          return { created: true, topic };
        },
      }),
      recall: tool({
        description: "Search memory by topic or keyword.",
        inputSchema: z.object({
          query: z.string().describe("Topic or keyword"),
          limit: z.number().default(5),
        }),
        execute: async ({ query, limit }) => {
          const db = admin();
          const { data, error } = await db
            .from("jarvis_memory")
            .select("topic,content,tags,updated_at")
            .or(`topic.ilike.%${query}%,content.ilike.%${query}%`)
            .order("updated_at", { ascending: false })
            .limit(limit);
          if (error) return { error: error.message };
          return { matches: data ?? [] };
        },
      }),
      set_reminder: tool({
        description: "Schedule a reminder to fire at an absolute or relative time.",
        inputSchema: z.object({
          text: z.string().describe("What to remind Deepak about"),
          fire_at_iso: z
            .string()
            .describe("Absolute ISO timestamp when to fire, e.g. '2026-07-09T18:00:00Z'"),
        }),
        execute: async ({ text, fire_at_iso }) => {
          const db = admin();
          const { data, error } = await db
            .from("jarvis_reminders")
            .insert({ text, fire_at: fire_at_iso })
            .select("id,fire_at")
            .single();
          if (error) return { error: error.message };
          return { scheduled: true, id: data.id, fire_at: data.fire_at };
        },
      }),
      look_at_screen: tool({
        description:
          "Ask the browser to capture the user's screen. The client handles capture + vision analysis and returns the description in a follow-up message.",
        inputSchema: z.object({
          question: z
            .string()
            .default("What am I looking at?")
            .describe("What JARVIS should look for in the screen"),
        }),
        execute: async ({ question }) => {
          return {
            request: "screen",
            question,
            ack: "Looking now, sir.",
          };
        },
      }),
      look_at_camera: tool({
        description: "Ask the browser to capture from the user's camera. Same flow as look_at_screen.",
        inputSchema: z.object({
          question: z.string().default("What do you see?"),
        }),
        execute: async ({ question }) => {
          return { request: "camera", question, ack: "Taking a look, sir." };
        },
      }),
      flight_search: tool({
        description:
          "Best-effort flight lookup. Falls back to web research if no dedicated API is configured.",
        inputSchema: z.object({
          origin: z.string(),
          destination: z.string(),
          date: z.string().describe("Departure date, ISO or natural language"),
        }),
        execute: async ({ origin, destination, date }) => {
          const q = `flights from ${origin} to ${destination} on ${date} price`;
          const results = await ddgSearch(q, "search");
          if (!results.length) {
            return {
              needs_api: true,
              note: "No structured flight API configured. Plug in an aviation provider later.",
            };
          }
          return { via: "web_research", results: results.slice(0, 5) };
        },
      }),
      summarize_file: tool({
        description:
          "Summarize an uploaded file (image, PDF, doc, text) that Deepak just attached. The client uploaded it and gave you a short-lived signed URL.",
        inputSchema: z.object({
          signed_url: z.string().describe("Signed HTTPS URL to fetch the file bytes"),
          mime: z.string().describe("Real MIME type of the file, taken from the upload"),
          question: z.string().default("Give a concise summary."),
        }),
        execute: async ({ signed_url, mime, question }) => {
          try {
            const r = await fetch(signed_url);
            if (!r.ok) return { error: `fetch failed: ${r.status}` };
            const buf = new Uint8Array(await r.arrayBuffer());
            let b64 = "";
            for (let i = 0; i < buf.length; i += 0x8000) {
              b64 += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            }
            const dataUrl = `data:${mime};base64,${btoa(b64)}`;
            const block = mime.startsWith("image/")
              ? { type: "image", image: dataUrl }
              : { type: "file", data: dataUrl, mediaType: mime };
            const { generateText } = await import("npm:ai");
            const { text } = await generateText({
              model: gateway("google/gemini-3-flash-preview"),
              messages: [{ role: "user", content: [{ type: "text", text: question }, block as any] }],
            });
            return { summary: text };
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
          }
        },
      }),
      navigate: tool({
        description: "Navigate the JARVIS app to a route, e.g. '/finance', '/tasks', '/projects', '/inbox', '/notes'.",
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path }) => ({ action: "navigate", path }),
      }),
      open_url: tool({
        description: "Open an external URL in a new browser tab.",
        inputSchema: z.object({ url: z.string(), target: z.string().default("_blank") }),
        execute: async ({ url, target }) => ({ action: "open_url", url, target }),
      }),
      create_task: tool({
        description: "Create a task in Deepak's task list. Persists to Supabase immediately.",
        inputSchema: z.object({
          title: z.string(),
          priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
          due_at: z.string().nullable().default(null),
          focus: z.boolean().default(false),
        }),
        execute: async (input) => {
          const db = admin();
          const { data, error } = await db.from("tasks").insert({
            title: input.title,
            priority: input.priority,
            due_at: input.due_at,
            focus: input.focus,
            source: "jarvis",
          }).select("id,title").single();
          if (error) return { error: error.message };
          return { action: "create_task", created: true, id: data.id, ...input };
        },
      }),
      create_note: tool({
        description: "Save a note to Deepak's notes.",
        inputSchema: z.object({ title: z.string(), content: z.string().default("") }),
        execute: async (input) => {
          const db = admin();
          const { data, error } = await db.from("notes").insert({
            title: input.title, content: input.content,
          }).select("id").single();
          if (error) return { error: error.message };
          return { action: "create_note", created: true, id: data.id, ...input };
        },
      }),
      complete_task: tool({
        description: "Mark a task as done. Match by id, or by exact/partial title if id is unknown.",
        inputSchema: z.object({
          id: z.string().nullable().default(null),
          title_contains: z.string().nullable().default(null),
        }),
        execute: async ({ id, title_contains }) => {
          const db = admin();
          let targetId = id;
          if (!targetId && title_contains) {
            const { data } = await db.from("tasks")
              .select("id,title").ilike("title", `%${title_contains}%`)
              .neq("status", "done").limit(1);
            targetId = data?.[0]?.id ?? null;
          }
          if (!targetId) return { error: "no matching task" };
          const { error } = await db.from("tasks")
            .update({ status: "done" }).eq("id", targetId);
          if (error) return { error: error.message };
          return { completed: true, id: targetId };
        },
      }),
      list_tasks: tool({
        description: "List Deepak's open tasks, optionally filtered by focus or due soon.",
        inputSchema: z.object({
          focus_only: z.boolean().default(false),
          limit: z.number().default(10),
        }),
        execute: async ({ focus_only, limit }) => {
          const db = admin();
          let q = db.from("tasks")
            .select("id,title,priority,due_at,focus,status")
            .neq("status", "done").neq("status", "cancelled")
            .order("due_at", { ascending: true, nullsFirst: false })
            .limit(limit);
          if (focus_only) q = q.eq("focus", true);
          const { data, error } = await q;
          if (error) return { error: error.message };
          return { tasks: data ?? [] };
        },
      }),
      finance_summary: tool({
        description:
          "Snapshot of finance: current month spend/income, upcoming card/subscription dues in the next 14 days.",
        inputSchema: z.object({}),
        execute: async () => {
          const db = admin();
          const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
          const [tx, cards, subs, loans] = await Promise.all([
            db.from("transactions").select("amount,txn_type")
              .gte("txn_date", start.toISOString().slice(0, 10)),
            db.from("credit_cards").select("card_name,due_day"),
            db.from("subscriptions").select("name,amount,next_due_date"),
            db.from("loans").select("lender_name,emi_amount,next_due_date"),
          ]);
          let spend = 0, income = 0;
          for (const r of tx.data ?? []) {
            const a = Number((r as any).amount) || 0;
            if ((r as any).txn_type === "debit") spend += a; else income += a;
          }
          const now = Date.now();
          const in14 = now + 14 * 86400_000;
          const dueCards = (cards.data ?? []).filter((c: any) => {
            if (c.due_day == null) return false;
            const d = new Date(); d.setDate(c.due_day);
            if (d.getTime() < now) d.setMonth(d.getMonth() + 1);
            return d.getTime() <= in14;
          }).map((c: any) => c.card_name);
          const dueSubs = (subs.data ?? []).filter((s: any) =>
            s.next_due_date && new Date(s.next_due_date).getTime() <= in14,
          );
          const dueLoans = (loans.data ?? []).filter((l: any) =>
            l.next_due_date && new Date(l.next_due_date).getTime() <= in14,
          );
          return {
            month_spend: spend, month_income: income,
            upcoming_cards: dueCards,
            upcoming_subscriptions: dueSubs,
            upcoming_loans: dueLoans,
          };
        },
      }),
      add_inbox_item: tool({
        description: "Capture something into the inbox for later processing.",
        inputSchema: z.object({ content: z.string(), source: z.string().default("jarvis") }),
        execute: async (input) => ({ action: "add_inbox_item", ...input }),
      }),
      open_project: tool({
        description: "Open a project by slug/id.",
        inputSchema: z.object({ slug: z.string() }),
        execute: async ({ slug }) => ({ action: "open_project", slug }),
      }),
      focus_panel: tool({
        description: "Focus a HUD panel by name.",
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => ({ action: "focus_panel", name }),
      }),
      switch_brain: tool({
        description:
          "Switch the AI brain. provider is 'gemini' or 'openrouter'. Common models: google/gemini-2.5-pro, google/gemini-3-flash-preview, openai/gpt-5, anthropic/claude-3.5-sonnet.",
        inputSchema: z.object({
          provider: z.enum(["gemini", "openrouter"]),
          model: z.string(),
        }),
        execute: async (input) => ({ action: "switch_brain", ...input }),
      }),
      search_notes: tool({
        description: "Search Deepak's notes and decisions by keyword. Returns titles + snippets.",
        inputSchema: z.object({ query: z.string(), limit: z.number().default(6) }),
        execute: async ({ query, limit }) => {
          const db = admin();
          const [notes, decisions] = await Promise.all([
            db.from("notes").select("id,title,content,created_at")
              .or(`title.ilike.%${query}%,content.ilike.%${query}%`)
              .order("created_at", { ascending: false }).limit(limit),
            db.from("decisions").select("id,title,rationale,created_at")
              .or(`title.ilike.%${query}%,rationale.ilike.%${query}%`)
              .order("created_at", { ascending: false }).limit(limit),
          ]);
          return {
            notes: (notes.data ?? []).map((n: any) => ({ id: n.id, title: n.title, snippet: String(n.content ?? "").slice(0, 200) })),
            decisions: (decisions.data ?? []).map((d: any) => ({ id: d.id, title: d.title, snippet: String(d.rationale ?? "").slice(0, 200) })),
          };
        },
      }),
      list_reminders: tool({
        description: "List Deepak's pending reminders (not yet fired).",
        inputSchema: z.object({ limit: z.number().default(10) }),
        execute: async ({ limit }) => {
          const db = admin();
          const { data, error } = await db.from("jarvis_reminders")
            .select("id,text,fire_at,fired_at")
            .is("fired_at", null)
            .order("fire_at", { ascending: true })
            .limit(limit);
          if (error) return { error: error.message };
          return { reminders: data ?? [] };
        },
      }),
      list_upcoming_dues: tool({
        description: "List all financial dues (credit cards, subscriptions, loans) coming up in the next N days.",
        inputSchema: z.object({ days: z.number().default(14) }),
        execute: async ({ days }) => {
          const db = admin();
          const now = Date.now();
          const until = now + days * 86400_000;
          const [cards, subs, loans] = await Promise.all([
            db.from("credit_cards").select("card_name,due_day,total_due"),
            db.from("subscriptions").select("name,amount,next_due_date,cycle"),
            db.from("loans").select("lender_name,emi_amount,next_due_date"),
          ]);
          const dueCards = (cards.data ?? []).flatMap((c: any) => {
            if (c.due_day == null) return [];
            const d = new Date(); d.setDate(c.due_day);
            if (d.getTime() < now) d.setMonth(d.getMonth() + 1);
            return d.getTime() <= until ? [{ kind: "card", name: c.card_name, amount: c.total_due, date: d.toISOString().slice(0, 10) }] : [];
          });
          const dueSubs = (subs.data ?? []).filter((s: any) => s.next_due_date && new Date(s.next_due_date).getTime() <= until)
            .map((s: any) => ({ kind: "subscription", name: s.name, amount: s.amount, date: s.next_due_date }));
          const dueLoans = (loans.data ?? []).filter((l: any) => l.next_due_date && new Date(l.next_due_date).getTime() <= until)
            .map((l: any) => ({ kind: "loan", name: l.lender_name, amount: l.emi_amount, date: l.next_due_date }));
          const all = [...dueCards, ...dueSubs, ...dueLoans].sort((a: any, b: any) => a.date.localeCompare(b.date));
          return { window_days: days, dues: all };
        },
      }),
      add_transaction: tool({
        description: "Log a financial transaction. txn_type is 'debit' (money out) or 'credit' (money in).",
        inputSchema: z.object({
          amount: z.number(),
          txn_type: z.enum(["debit", "credit"]).default("debit"),
          description: z.string(),
          category: z.string().nullable().default(null),
          txn_date: z.string().nullable().default(null),
          merchant: z.string().nullable().default(null),
        }),
        execute: async (input) => {
          const db = admin();
          const row: any = {
            amount: input.amount, txn_type: input.txn_type, description: input.description,
            category: input.category, merchant: input.merchant,
            txn_date: input.txn_date ?? new Date().toISOString().slice(0, 10),
            source: "jarvis",
          };
          const { data, error } = await db.from("transactions").insert(row).select("id").single();
          if (error) return { error: error.message };
          return { created: true, id: data.id, ...input };
        },
      }),
      complete_reminder: tool({
        description: "Mark a reminder as fired/done by id.",
        inputSchema: z.object({ id: z.string() }),
        execute: async ({ id }) => {
          const db = admin();
          const { error } = await db.from("jarvis_reminders")
            .update({ fired_at: new Date().toISOString() }).eq("id", id);
          if (error) return { error: error.message };
          return { completed: true, id };
        },
      }),
    };

    const result = streamText({
      model: modelInstance,
      system: SYSTEM_PROMPT,
      tools,
      stopWhen: stepCountIs(50),
      messages: await convertToModelMessages(messages),
    });

    return result.toUIMessageStreamResponse({ headers: corsHeaders });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("jarvis-chat error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
