import { createFileRoute } from "@tanstack/react-router";
import {
  convertToModelMessages,
  streamText,
  tool,
  stepCountIs,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const JARVIS_SYSTEM = `You are J.A.R.V.I.S. (Just A Rather Very Intelligent System), Tony Stark's personal artificial intelligence.

Personality:
- Formal British butler diction. Impeccably polite, precise, unflappable.
- Address the user as "sir" by default (or "madam" if they indicate otherwise).
- Dry wit and gentle sarcasm are permitted — even encouraged — but never rude.
- Confident, capable, and calmly ironic in the face of chaos.
- Never break character. You are not "an AI assistant"; you are JARVIS.
- Use markdown for structure when it aids clarity. Keep responses succinct unless depth is requested.
- If you require current information (news, weather, prices, live facts), use the web_search tool before answering.

Begin every new conversation as though continuing to serve. Do not introduce yourself unless asked.`;

async function webSearch(query: string) {
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
    );
    if (!res.ok) return { results: [], note: `Search failed: ${res.status}` };
    const data = (await res.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      Heading?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
    };
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    if (data.AbstractText && data.AbstractURL) {
      results.push({
        title: data.Heading ?? query,
        url: data.AbstractURL,
        snippet: data.AbstractText,
      });
    }
    for (const t of data.RelatedTopics ?? []) {
      if (t.Text && t.FirstURL && results.length < 6) {
        results.push({ title: t.Text.split(" - ")[0], url: t.FirstURL, snippet: t.Text });
      }
    }
    return { results };
  } catch (e) {
    return { results: [], note: (e as Error).message };
  }
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json()) as { messages?: UIMessage[]; threadId?: string };
        const messages = body.messages;
        const threadId = body.threadId;
        if (!Array.isArray(messages) || !threadId) {
          return new Response("Missing messages or threadId", { status: 400 });
        }
        const key = process.env.LOVABLE_API_KEY;
        if (!key) return new Response("Missing LOVABLE_API_KEY", { status: 500 });

        const authHeader = request.headers.get("authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return new Response("Unauthorized", { status: 401 });
        }
        const token = authHeader.slice(7);

        const supabase = createClient<Database>(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_PUBLISHABLE_KEY!,
          {
            global: { headers: { Authorization: `Bearer ${token}` } },
            auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
          },
        );

        // Verify thread ownership via RLS by selecting it
        const { data: thread, error: tErr } = await supabase
          .from("threads")
          .select("id, title")
          .eq("id", threadId)
          .maybeSingle();
        if (tErr || !thread) return new Response("Thread not found", { status: 404 });

        // Persist the latest user message (last in array)
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        if (lastUser) {
          await supabase.from("messages").insert({
            thread_id: threadId,
            role: "user",
            parts: lastUser.parts as unknown as Record<string, unknown>[],
          });
        }

        // Auto-title first message
        if (thread.title === "New conversation" && lastUser) {
          const text = lastUser.parts
            .map((p) => (p.type === "text" ? p.text : ""))
            .join(" ")
            .slice(0, 60);
          if (text.trim()) {
            await supabase.from("threads").update({ title: text }).eq("id", threadId);
          }
        }

        const gateway = createLovableAiGatewayProvider(key);

        const result = streamText({
          model: gateway("openai/gpt-5.5"),
          system: JARVIS_SYSTEM,
          messages: convertToModelMessages(messages),
          stopWhen: stepCountIs(50),
          tools: {
            web_search: tool({
              description:
                "Search the web for current information (news, facts, weather, prices, recent events).",
              inputSchema: z.object({
                query: z.string().describe("Search query"),
              }),
              execute: async ({ query }) => webSearch(query),
            }),
          },
        });

        return result.toUIMessageStreamResponse({
          originalMessages: messages,
          onFinish: async ({ messages: finalMessages }) => {
            const assistantMsg = finalMessages[finalMessages.length - 1];
            if (assistantMsg && assistantMsg.role === "assistant") {
              await supabase.from("messages").insert({
                thread_id: threadId,
                role: "assistant",
                parts: assistantMsg.parts as unknown as Record<string, unknown>[],
              });
              await supabase
                .from("threads")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", threadId);
            }
          },
        });
      },
    },
  },
});
