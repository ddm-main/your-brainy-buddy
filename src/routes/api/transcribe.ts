import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env.LOVABLE_API_KEY;
        if (!key) return new Response("Missing LOVABLE_API_KEY", { status: 500 });

        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof Blob)) return new Response("Missing file", { status: 400 });

        const upstream = new FormData();
        upstream.append("file", file, "recording.wav");
        upstream.append("model", "openai/gpt-4o-transcribe");

        const res = await fetch(
          "https://ai.gateway.lovable.dev/v1/audio/transcriptions",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${key}` },
            body: upstream,
          },
        );
        const text = await res.text();
        return new Response(text, {
          status: res.status,
          headers: {
            "content-type": res.headers.get("content-type") ?? "application/json",
          },
        });
      },
    },
  },
});
