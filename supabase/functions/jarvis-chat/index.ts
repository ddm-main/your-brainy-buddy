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
    const { messages }: { messages: UIMessage[] } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const gateway = createLovableAiGatewayProvider(key);

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
    };

    const gatewayModel = gateway("google/gemini-3-flash-preview");

    const result = streamText({
      model: gatewayModel,
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
