// JARVIS backend utility: run a SQL file against the Supabase project.
// Usage: node db.mjs <file.sql>
// Requires env vars: SUPABASE_PROJECT_REF, SUPABASE_ACCESS_TOKEN
import { readFileSync } from 'node:fs';

const sqlFile = process.argv[2];
if (!sqlFile) { console.error('usage: node db.mjs <file.sql>'); process.exit(1); }

const ref = process.env.SUPABASE_PROJECT_REF;
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!ref || !token) { console.error('SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN not set'); process.exit(1); }

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: readFileSync(sqlFile, 'utf8') }),
});
const text = await res.text();
console.log(`HTTP ${res.status}`);
try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
if (!res.ok) process.exit(1);
