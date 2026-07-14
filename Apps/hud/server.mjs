// Shim: delegates to Vite dev. Kept because lovable.toml is read-only and
// invokes this path. Real dev config lives in package.json / vite.config.ts.
import { spawn } from "node:child_process";
const p = spawn("npx", ["vite", "--host", "0.0.0.0", "--port", process.env.PORT || "8080"], { stdio: "inherit" });
p.on("exit", (c) => process.exit(c ?? 0));
