import { supabase as _supabase } from "@/integrations/supabase/client";
import { authHeaders } from "@/lib/authFetch";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = _supabase as any;

const FN_UPLOAD = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/jarvis-vision-upload`;
const FN_VISION = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/jarvis-vision`;

async function canvasToBase64Jpeg(canvas: HTMLCanvasElement, quality = 0.7): Promise<string> {
  const blob: Blob = await new Promise((res) =>
    canvas.toBlob((b) => res(b as Blob), "image/jpeg", quality),
  );
  const buf = await blob.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function captureFrame(stream: MediaStream): Promise<HTMLCanvasElement> {
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  await new Promise((r) => setTimeout(r, 350)); // let a real frame land
  const c = document.createElement("canvas");
  c.width = Math.min(1280, video.videoWidth || 1280);
  c.height = Math.min(720, video.videoHeight || 720);
  const ctx = c.getContext("2d")!;
  ctx.drawImage(video, 0, 0, c.width, c.height);
  return c;
}

async function uploadJpeg(base64: string, filename: string): Promise<{ url: string; path: string }> {
  const r = await fetch(FN_UPLOAD, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ filename, contentType: "image/jpeg", bytesBase64: base64 }),
  });
  if (!r.ok) throw new Error(`upload failed ${r.status}: ${await r.text()}`);
  return r.json();
}

async function analyze(imageUrl: string, kind: "screen" | "camera", question?: string): Promise<string> {
  const r = await fetch(FN_VISION, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ image_url: imageUrl, kind, question }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error ?? `vision failed ${r.status}`);
  return j.description as string;
}

export interface VisionResult {
  thumbDataUrl: string;
  signedUrl: string;
  description: string;
  kind: "screen" | "camera";
}

export async function captureAndDescribe(kind: "screen" | "camera", question?: string): Promise<VisionResult> {
  const stream = kind === "screen"
    ? await navigator.mediaDevices.getDisplayMedia({ video: true })
    : await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
  try {
    const canvas = await captureFrame(stream);
    const b64 = await canvasToBase64Jpeg(canvas, 0.7);
    const thumb = canvas.toDataURL("image/jpeg", 0.5);
    const { url } = await uploadJpeg(b64, `${kind}.jpg`);
    const description = await analyze(url, kind, question);
    return { thumbDataUrl: thumb, signedUrl: url, description, kind };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

// Kept for future direct-upload flows.
export async function directUpload(file: File): Promise<{ url: string; path: string }> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return uploadJpeg(btoa(bin), file.name);
}

// silence unused import warnings
void supabase;