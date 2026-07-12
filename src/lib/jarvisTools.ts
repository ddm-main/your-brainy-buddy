// Client-side dispatcher for JARVIS control tools. The edge function's tool
// `execute()` returns an intent; this dispatcher runs the intent in the browser.

import { db } from "@/lib/db";
import { supabase as _supabase } from "@/integrations/supabase/client";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = _supabase as any;
import { useUi } from "@/store/uiStore";
import { useBrain, BRAIN_PRESETS, type BrainProvider } from "@/store/brainStore";

let navigator_: ((path: string) => void) | null = null;
export function registerNavigator(fn: (path: string) => void) {
  navigator_ = fn;
}

export interface ToolIntent {
  action: string;
  [k: string]: unknown;
}

export async function runToolIntent(name: string, intent: ToolIntent): Promise<void> {
  try {
    switch (name) {
      case "navigate": {
        const path = String(intent.path ?? "/");
        if (navigator_) navigator_(path);
        else window.location.hash = path;
        useUi.getState().push(`Navigated to ${path}`, "ok");
        return;
      }
      // open_url removed — external navigation disabled to close the injection exfiltration channel.

      // create_task / create_note are handled entirely server-side (see
      // jarvis-chat/index.ts's tool handlers) — the client only shows a
      // confirmation toast (see jarvisChat.ts's handleToolResult). Do not
      // add a client-side insert here; that caused duplicate rows (Round 3
      // fix — the server tool inserted the row, and this dispatcher was
      // also inserting a second one on every voice/chat-created task/note).

      case "add_inbox_item": {
        const { error } = await supabase.from("inbox_items").insert({
          content: String(intent.content ?? ""),
          source: String(intent.source ?? "jarvis"),
        } as any);
        if (error) throw error;
        useUi.getState().push("Added to inbox", "ok");
        return;
      }
      case "open_project": {
        const slug = String(intent.slug ?? "");
        if (!navigator_) return;
        // ProjectDetail looks up by id, not slug — resolve it here so the
        // link doesn't silently 404. Falls back to a raw nav if no match is
        // found, so this never hard-fails the intent.
        const proj = slug ? await db.projects.getBySlug(slug) : null;
        navigator_(proj ? `/projects/${proj.id}` : `/projects${slug ? `/${slug}` : ""}`);
        return;
      }
      case "focus_panel": {
        const name = String(intent.name ?? "");
        useUi.getState().push(`Focus: ${name}`, "info");
        return;
      }
      case "switch_brain": {
        const provider = String(intent.provider ?? "gemini") as BrainProvider;
        const model = String(
          intent.model ??
            BRAIN_PRESETS.find((b) => b.provider === provider)?.model ??
            "google/gemini-3-flash-preview",
        );
        useBrain.getState().setBrain({ provider, model });
        useUi.getState().push(`Brain: ${model}`, "ok");
        return;
      }
      default:
        return;
    }
  } catch (err: any) {
    useUi.getState().push(`Tool ${name} failed: ${err?.message ?? err}`, "err");
  }
}