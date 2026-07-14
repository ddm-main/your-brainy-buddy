import { useRef, useState } from "react";
import HudPanel from "@/components/hud/HudPanel";
import { Btn, inputStyle } from "@/components/hud/HudControls";
import BrainPicker from "@/components/core/BrainPicker";
import { authFetch } from "@/lib/authFetch";
import { useBrain } from "@/store/brainStore";
import { useUi } from "@/store/uiStore";

interface Msg { id: string; role: "user" | "assistant"; text: string; tools: string[] }

/** Minimal streaming Finance chat. POSTs UI-message payload to
 * finance-chat and parses the SSE UI-message stream inline (text-delta
 * + tool-input-available events). No @ai-sdk/react coupling to keep
 * this route framework-light. */
export default function FinanceChat() {
  const push = useUi((s) => s.push);
  const { provider, model } = useBrain();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const scroll = () => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const uid = crypto.randomUUID();
    const aid = crypto.randomUUID();
    const userMsg: Msg = { id: uid, role: "user", text, tools: [] };
    const asstMsg: Msg = { id: aid, role: "assistant", text: "", tools: [] };
    setMessages((m) => [...m, userMsg, asstMsg]);
    setBusy(true);
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/finance-chat`;
      const body = {
        provider, model,
        messages: [...messages, userMsg].map((m) => ({
          id: m.id, role: m.role,
          parts: [{ type: "text", text: m.text }],
        })),
      };
      const r = await authFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok || !r.body) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error ?? `chat failed (${r.status})`);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") continue;
          let ev: any;
          try { ev = JSON.parse(raw); } catch { continue; }
          if (ev.type === "text-delta" && typeof ev.delta === "string") {
            setMessages((m) => m.map((x) => x.id === aid ? { ...x, text: x.text + ev.delta } : x));
          } else if (ev.type === "tool-input-available" && ev.toolName) {
            setMessages((m) => m.map((x) => x.id === aid ? { ...x, tools: [...x.tools, ev.toolName] } : x));
          } else if (ev.type === "error") {
            throw new Error(ev.errorText ?? "stream error");
          }
          scroll();
        }
      }
    } catch (e: any) {
      push(e?.message ?? "chat failed", "err");
      setMessages((m) => m.map((x) => x.id === aid ? { ...x, text: `[error: ${e?.message ?? "failed"}]` } : x));
    } finally { setBusy(false); scroll(); }
  };

  return (
    <HudPanel title="Finance Chat" index="AI" live={busy ? "warn" : "ok"} actions={<BrainPicker />}>
      <div ref={scrollRef} style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
        {messages.length === 0 && (
          <div className="hud-label" style={{ color: "var(--text-dim)" }}>
            ask about your money — "spend on food last month?", "budget status", "top merchants"…
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} style={{
            padding: "6px 10px", border: "1px solid var(--edge)", borderRadius: 3,
            background: m.role === "user" ? "rgba(53,214,237,0.05)" : "transparent",
            fontSize: 12, color: "var(--text)", whiteSpace: "pre-wrap", lineHeight: 1.4,
          }}>
            <div className="hud-label" style={{ marginBottom: 2, color: m.role === "user" ? "var(--accent)" : "var(--text-muted)" }}>{m.role}</div>
            {m.tools.length > 0 && (
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>
                · {m.tools.join(" · ")}
              </div>
            )}
            {m.text || (m.role === "assistant" && busy ? "…" : "")}
          </div>
        ))}
      </div>
      <form onSubmit={send} style={{ display: "flex", gap: 6 }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="ask JARVIS about your finances…"
          style={{ ...inputStyle, flex: 1 }} disabled={busy} />
        <Btn type="submit" variant="primary" disabled={busy || !input.trim()}>{busy ? "…" : "send"}</Btn>
      </form>
    </HudPanel>
  );
}
