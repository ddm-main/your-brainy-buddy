// Sandbox launcher: the sandbox daemon runs `node Apps/hud/server.mjs`, so we
// forward that into the Vite dev server on the same port. This keeps the fresh
// src/ code live during development instead of the stale prebuilt bundle that
// used to sit in Apps/hud/public/.
//
// Also supervises the Kotak WS live-tick relay (Apps/relay/kotak-ws-relay.mjs)
// as a second child process so live prices push in real time instead of
// falling back to the 1s REST poll / cached EOD close. The relay needs a
// local .env (SUPABASE_SERVICE_ROLE_KEY + STATEMENT_ENC_SECRET — see
// .env.example) and a Kotak session already connected via Settings; if the
// .env isn't there yet we skip the relay and say so once, rather than
// blocking the HUD itself.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const port = String(process.env.PORT || 8080);

const vite = spawn(
  process.execPath,
  [resolve(repoRoot, "node_modules/vite/bin/vite.js"), "--host", "0.0.0.0", "--port", port],
  { cwd: repoRoot, stdio: "inherit", env: { ...process.env, PORT: port } },
);
vite.on("exit", (code) => process.exit(code ?? 0));

// ---- Relay supervision -----------------------------------------------
const RELAY_RESTART_DELAY_MS = 3_000;
const RELAY_CRASH_WINDOW_MS = 60_000;
const RELAY_MAX_CRASHES = 5;

let relay = null;
let relayStopped = false;
let crashTimestamps = [];

function startRelay() {
  if (relayStopped) return;
  const envPath = resolve(repoRoot, ".env");
  if (!existsSync(envPath)) {
    console.log("[hud] .env not found — skipping live-tick relay (copy .env.example to .env to enable real-time prices).");
    return;
  }

  relay = spawn(
    process.execPath,
    [`--env-file=${envPath}`, resolve(repoRoot, "Apps/relay/kotak-ws-relay.mjs")],
    { cwd: repoRoot, stdio: "inherit", env: process.env },
  );

  relay.on("exit", (code, signal) => {
    relay = null;
    if (relayStopped || signal) return; // clean shutdown, not a crash
    if (code === 0) return; // relay's own SIGINT/SIGTERM handlers exit(0) on graceful stop

    const now = Date.now();
    crashTimestamps = crashTimestamps.filter((t) => now - t < RELAY_CRASH_WINDOW_MS);
    crashTimestamps.push(now);
    if (crashTimestamps.length > RELAY_MAX_CRASHES) {
      console.error(`[hud] live-tick relay crashed ${RELAY_MAX_CRASHES}+ times in ${RELAY_CRASH_WINDOW_MS / 1000}s — giving up. Check the [relay] logs above.`);
      return;
    }
    console.error(`[hud] live-tick relay exited (code ${code}) — restarting in ${RELAY_RESTART_DELAY_MS / 1000}s…`);
    setTimeout(startRelay, RELAY_RESTART_DELAY_MS);
  });
}

startRelay();

process.on("SIGTERM", () => { relayStopped = true; vite.kill("SIGTERM"); relay?.kill("SIGTERM"); });
process.on("SIGINT", () => { relayStopped = true; vite.kill("SIGINT"); relay?.kill("SIGINT"); });
