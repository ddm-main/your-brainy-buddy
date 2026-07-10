import { supabase as _supabase } from "@/integrations/supabase/client";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = _supabase as any;

const FN_UPLOAD = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/jarvis-vision-upload`;

let currentStream: MediaStream | null = null;
let hiddenVideo: HTMLVideoElement | null = null;
const listeners = new Set<(sharing: boolean) => void>();

function notify() {
  const sharing = !!currentStream;
  listeners.forEach((l) => l(sharing));
}

export function onScreenShareChange(cb: (sharing: boolean) => void) {
  listeners.add(cb);
  cb(!!currentStream);
  return () => listeners.delete(cb);
}

export function isSharing() {
  return !!currentStream;
}

export async function startShare(): Promise<void> {
  if (currentStream) return;
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  currentStream = stream;
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  hiddenVideo = video;
  stream.getVideoTracks()[0]?.addEventListener("ended", stopShare);
  notify();
}

export function stopShare(): void {
  currentStream?.getTracks().forEach((t) => t.stop());
  currentStream = null;
  hiddenVideo = null;
  notify();
}

async function frameToJpegBase64(quality = 0.7): Promise<{ base64: string; thumb: string }> {
  if (!hiddenVideo || !currentStream) throw new Error("Screen share not active");
  const w = Math.min(1280, hiddenVideo.videoWidth || 1280);
  const h = Math.min(720, hiddenVideo.videoHeight || 720);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(hiddenVideo, 0, 0, w, h);
  const blob: Blob = await new Promise((res) =>
    c.toBlob((b) => res(b as Blob), "image/jpeg", quality),
  );
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return { base64: btoa(bin), thumb: c.toDataURL("image/jpeg", 0.5) };
}

export async function captureShareFrame(): Promise<{ url: string; thumb: string }> {
  const { base64, thumb } = await frameToJpegBase64();
  const r = await fetch(FN_UPLOAD, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string,
    },
    body: JSON.stringify({ filename: `share_${Date.now()}.jpg`, contentType: "image/jpeg", bytesBase64: base64 }),
  });
  if (!r.ok) throw new Error(`upload failed ${r.status}`);
  const j = await r.json();
  return { url: j.url as string, thumb };
}

void supabase;