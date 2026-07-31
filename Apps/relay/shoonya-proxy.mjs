#!/usr/bin/env node
// Shoonya static-IP proxy.
//
// Run this on a small VPS or machine with a stable public IP, then whitelist
// that IP in Shoonya PRISM → API Key. Supabase Edge calls this proxy instead
// of talking to api.shoonya.com from rotating cloud egress addresses.

import http from "node:http";

const PORT = Number(process.env.PORT || process.env.SHOONYA_PROXY_PORT || 3970);
const SECRET = process.env.SHOONYA_PROXY_SECRET;
const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_BASE_PATHS = new Set(["/NorenWClientAPI", "/NorenWClientWeb", "/NorenWClientTP"]);

if (!SECRET) {
  console.error("[shoonya-proxy] Missing SHOONYA_PROXY_SECRET.");
  process.exit(1);
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function assertAllowedTarget(base, route) {
  const u = new URL(String(base || ""));
  if (u.protocol !== "https:" || u.hostname !== "api.shoonya.com") {
    throw new Error("base must be https://api.shoonya.com/<Noren path>");
  }
  if (!ALLOWED_BASE_PATHS.has(u.pathname.replace(/\/+$/, ""))) {
    throw new Error("unsupported Shoonya API base path");
  }
  const r = String(route || "").trim();
  if (!/^[A-Za-z0-9_/-]{1,80}$/.test(r) || r.includes("..") || r.startsWith("/")) {
    throw new Error("unsupported Shoonya route");
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}/${r}`;
}

async function handleShoonya(req, res) {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${SECRET}`) return json(res, 401, { error: "unauthorized" });

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return json(res, 400, { error: e instanceof Error ? e.message : "invalid JSON" });
  }

  let url;
  try {
    url = assertAllowedTarget(payload.base, payload.route);
  } catch (e) {
    return json(res, 400, { error: e instanceof Error ? e.message : "invalid Shoonya target" });
  }

  const contentType = typeof payload.contentType === "string" && payload.contentType.trim()
    ? payload.contentType.trim()
    : "application/x-www-form-urlencoded";
  const jData = payload.jData && typeof payload.jData === "object" && !Array.isArray(payload.jData)
    ? payload.jData
    : null;
  if (!jData) return json(res, 400, { error: "jData object is required" });

  const jKey = typeof payload.jKey === "string" && payload.jKey ? payload.jKey : null;
  const body = `jData=${JSON.stringify(jData)}` + (jKey ? `&jKey=${jKey}` : "");
  const headers = { "Content-Type": contentType };
  if (jKey) headers.Authorization = `Bearer ${jKey}`;

  try {
    const upstream = await fetch(url, { method: "POST", headers, body });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "text/plain",
      "Cache-Control": "no-store",
    });
    res.end(text);
  } catch (e) {
    json(res, 502, { stat: "Not_Ok", emsg: e instanceof Error ? e.message : "Shoonya proxy fetch failed" });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
  if (req.method === "POST" && req.url === "/shoonya") return void handleShoonya(req, res);
  json(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[shoonya-proxy] listening on :${PORT}; whitelist this machine's public IP in Shoonya PRISM`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));