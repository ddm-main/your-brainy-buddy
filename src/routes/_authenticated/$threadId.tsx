import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { supabase } from "@/integrations/supabase/client";
import {
  listThreads,
  createThread,
  deleteThread,
  getThreadMessages,
} from "@/lib/threads.functions";
import { Button } from "@/components/ui/button";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  Plus,
  Trash2,
  LogOut,
  Mic,
  Square,
  Volume2,
  VolumeX,
  Globe,
} from "lucide-react";
import jarvisOrb from "@/assets/jarvis-orb.png";

export const Route = createFileRoute("/_authenticated/$threadId")({
  component: ChatPage,
});

function ChatPage() {
  const { threadId } = useParams({ from: "/_authenticated/$threadId" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [voiceOn, setVoiceOn] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const recorderRef = useRef<{ stop: () => Promise<Blob>; stream: MediaStream } | null>(null);
  const spokenRef = useRef<Set<string>>(new Set());

  const threadsQuery = useQuery({
    queryKey: ["threads"],
    queryFn: () => listThreads(),
  });

  const messagesQuery = useQuery({
    queryKey: ["messages", threadId],
    queryFn: () => getThreadMessages({ data: { threadId } }),
  });

  const initialMessages: UIMessage[] = (messagesQuery.data ?? []).map((m) => ({
    id: m.id,
    role: m.role as "user" | "assistant",
    parts: (m.parts as unknown as UIMessage["parts"]) ?? [],
  }));

  const { messages, sendMessage, status, setMessages } = useChat({
    id: threadId,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      prepareSendMessagesRequest: async ({ messages, body }) => {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        return {
          body: { messages, threadId, ...body },
          headers,
        };
      },
    }),
  });

  // Load persisted messages on thread switch
  useEffect(() => {
    if (messagesQuery.data) {
      setMessages(
        messagesQuery.data.map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          parts: (m.parts as unknown as UIMessage["parts"]) ?? [],
        })),
      );
    }
  }, [threadId, messagesQuery.data, setMessages]);

  // Speak new assistant messages
  useEffect(() => {
    if (!voiceOn || typeof window === "undefined") return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || status === "streaming") return;
    if (spokenRef.current.has(last.id)) return;
    const text = last.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join(" ")
      .trim();
    if (!text) return;
    spokenRef.current.add(last.id);
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.0;
    utter.pitch = 0.9;
    const voices = window.speechSynthesis.getVoices();
    const british = voices.find(
      (v) =>
        v.lang?.startsWith("en-GB") &&
        /male|daniel|george|arthur/i.test(v.name + v.voiceURI),
    ) ?? voices.find((v) => v.lang?.startsWith("en-GB"));
    if (british) utter.voice = british;
    window.speechSynthesis.speak(utter);
  }, [messages, status, voiceOn]);

  useEffect(() => {
    if (!voiceOn && typeof window !== "undefined") window.speechSynthesis.cancel();
  }, [voiceOn]);

  const handleNewThread = async () => {
    const t = await createThread({ data: {} });
    await queryClient.invalidateQueries({ queryKey: ["threads"] });
    navigate({ to: "/$threadId", params: { threadId: t.id } });
  };

  const handleDeleteThread = async (id: string) => {
    await deleteThread({ data: { id } });
    await queryClient.invalidateQueries({ queryKey: ["threads"] });
    if (id === threadId) navigate({ to: "/" });
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth" });
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      processor.onaudioprocess = (e) => {
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(ctx.destination);
      const sampleRate = ctx.sampleRate;

      recorderRef.current = {
        stream,
        stop: async () => {
          stream.getTracks().forEach((t) => t.stop());
          processor.disconnect();
          source.disconnect();
          await ctx.close();
          return encodeWav(chunks, sampleRate);
        },
      };
      setIsRecording(true);
    } catch (e) {
      alert("Microphone access denied, sir.");
    }
  };

  const stopRecording = async () => {
    if (!recorderRef.current) return;
    const blob = await recorderRef.current.stop();
    recorderRef.current = null;
    setIsRecording(false);
    if (blob.size < 2048) return;
    setIsTranscribing(true);
    try {
      const fd = new FormData();
      fd.append("file", blob, "recording.wav");
      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = (await res.json()) as { text?: string };
      if (data.text) {
        await sendMessage({ text: data.text });
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsTranscribing(false);
    }
  };

  const [input, setInput] = useState("");
  const handleSubmit = async (message: { text: string }) => {
    const text = (message.text ?? input).trim();
    if (!text) return;
    setInput("");
    await sendMessage({ text });
  };


  const isLoading = status === "submitted" || status === "streaming";

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Sidebar */}
      <aside className="w-64 border-r border-primary/20 bg-card/40 backdrop-blur flex flex-col">
        <div className="p-4 border-b border-primary/20 flex items-center gap-3">
          <img src={jarvisOrb} alt="" width={32} height={32} className="jarvis-glow-sm" />
          <div>
            <div className="font-orbitron text-sm tracking-widest text-primary">J.A.R.V.I.S.</div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {isLoading ? "PROCESSING" : "STANDING BY"}
            </div>
          </div>
        </div>
        <div className="p-3">
          <Button onClick={handleNewThread} className="w-full" size="sm">
            <Plus className="size-4" /> New conversation
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
          {threadsQuery.data?.map((t) => (
            <div
              key={t.id}
              className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors ${
                t.id === threadId
                  ? "bg-primary/15 text-primary"
                  : "hover:bg-primary/5 text-foreground/80"
              }`}
            >
              <button
                onClick={() => navigate({ to: "/$threadId", params: { threadId: t.id } })}
                className="flex-1 text-left truncate cursor-pointer"
              >
                {t.title}
              </button>
              <button
                onClick={() => handleDeleteThread(t.id)}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity cursor-pointer"
                aria-label="Delete conversation"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="p-3 border-t border-primary/20 flex items-center justify-between">
          <button
            onClick={() => setVoiceOn((v) => !v)}
            className="text-muted-foreground hover:text-primary transition-colors cursor-pointer"
            title={voiceOn ? "Mute JARVIS" : "Unmute JARVIS"}
          >
            {voiceOn ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
          </button>
          <button
            onClick={handleSignOut}
            className="text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1 text-xs cursor-pointer"
          >
            <LogOut className="size-3.5" /> Sign out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col hud-grid">
        <Conversation className="flex-1">
          <ConversationContent className="max-w-3xl mx-auto w-full px-6 py-8">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <img
                  src={jarvisOrb}
                  alt=""
                  width={120}
                  height={120}
                  className="jarvis-glow mb-6"
                />
                <h2 className="text-2xl font-orbitron tracking-[0.2em] text-primary">
                  AT YOUR SERVICE
                </h2>
                <p className="mt-2 text-sm text-muted-foreground max-w-md">
                  How may I assist you today, sir? I can search the web, hold conversation, or
                  simply keep you company.
                </p>
              </div>
            )}

            {messages.map((message) => (
              <div key={message.id} className="mb-6">
                {message.role === "user" ? (
                  <div className="flex justify-end">
                    <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2.5">
                      {message.parts.map((part, i) =>
                        part.type === "text" ? (
                          <div key={i} className="whitespace-pre-wrap">
                            {part.text}
                          </div>
                        ) : null,
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-3">
                    <img
                      src={jarvisOrb}
                      alt=""
                      width={28}
                      height={28}
                      className="mt-1 shrink-0 jarvis-glow-sm"
                    />
                    <div className="flex-1 space-y-2 pt-1">
                      {message.parts.map((part, i) => {
                        if (part.type === "text") {
                          return (
                            <div key={i} className="prose prose-invert prose-sm max-w-none">
                              <ReactMarkdown>{part.text}</ReactMarkdown>
                            </div>
                          );
                        }
                        if (part.type === "tool-web_search" || part.type?.startsWith("tool-")) {
                          const p = part as unknown as {
                            type: string;
                            state: string;
                            input?: unknown;
                            output?: unknown;
                            errorText?: string;
                          };
                          return (
                            <Tool key={i} defaultOpen={false}>
                              <ToolHeader
                                type={"tool-web_search" as never}
                                state={p.state as never}
                              />

                              <ToolContent>
                                <ToolInput input={p.input} />
                                <ToolOutput
                                  output={p.output as never}
                                  errorText={p.errorText}
                                />
                              </ToolContent>
                            </Tool>
                          );
                        }
                        return null;
                      })}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {status === "submitted" && (
              <div className="flex gap-3">
                <img src={jarvisOrb} alt="" width={28} height={28} className="mt-1 jarvis-glow-sm animate-pulse" />
                <Shimmer className="pt-2">Processing, sir…</Shimmer>
              </div>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="border-t border-primary/20 bg-card/40 backdrop-blur">
          <div className="max-w-3xl mx-auto w-full px-6 py-4">
            <PromptInput onSubmit={handleSubmit}>
              <PromptInputTextarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  isTranscribing
                    ? "Transcribing..."
                    : isRecording
                    ? "Listening..."
                    : "Speak, sir."
                }
                disabled={isRecording || isTranscribing}
              />
              <div className="flex items-center justify-end gap-2 p-1">
                <Button
                  type="button"
                  size="icon-sm"
                  variant={isRecording ? "destructive" : "ghost"}
                  onClick={isRecording ? stopRecording : startRecording}
                  disabled={isTranscribing || isLoading}
                  aria-label={isRecording ? "Stop recording" : "Start recording"}
                >
                  {isRecording ? <Square className="size-4" /> : <Mic className="size-4" />}
                </Button>
                <PromptInputSubmit
                  status={status}
                  disabled={!input.trim() || isLoading}
                />
              </div>
            </PromptInput>
          </div>
        </div>
      </main>
    </div>
  );
}

function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const targetRate = 16000;
  // Flatten
  let total = 0;
  for (const c of chunks) total += c.length;
  const flat = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    flat.set(c, off);
    off += c.length;
  }
  // Downsample
  const ratio = sampleRate / targetRate;
  const outLen = Math.floor(flat.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = flat[Math.floor(i * ratio)];

  const buffer = new ArrayBuffer(44 + out.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + out.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, out.length * 2, true);
  let o = 44;
  for (let i = 0; i < out.length; i++) {
    const s = Math.max(-1, Math.min(1, out[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}
