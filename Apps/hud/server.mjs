// Sandbox launcher: the sandbox daemon runs `node Apps/hud/server.mjs`, so we
// forward that into the Vite dev server on the same port. This keeps the fresh
// src/ code live during development instead of the stale prebuilt bundle that
// used to sit in Apps/hud/public/.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const port = String(process.env.PORT || 8080);

const child = spawn(
  process.execPath,
  [resolve(repoRoot, "node_modules/vite/bin/vite.js"), "--host", "0.0.0.0", "--port", port],
  { cwd: repoRoot, stdio: "inherit", env: { ...process.env, PORT: port } },
);

child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
