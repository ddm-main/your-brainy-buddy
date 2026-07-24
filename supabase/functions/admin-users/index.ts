// Admin user-management edge function. Caller must be an admin.
// Actions: list | invite | update_role | update_access | delete
import { createClient } from "npm:@supabase/supabase-js@2";

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SECTIONS = ["hud", "market", "finance", "tasks", "projects", "inbox", "config"] as const;
type Section = typeof SECTIONS[number];

function j(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return j({ error: "method_not_allowed" }, 405);

  const URL_ = Deno.env.get("SUPABASE_URL")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return j({ error: "unauthorized" }, 401);
  const token = authHeader.slice(7);

  const asUser = createClient(URL_, ANON, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: claims, error: cErr } = await asUser.auth.getClaims(token);
  const uid = (claims?.claims as { sub?: string } | undefined)?.sub;
  if (cErr || !uid) return j({ error: "unauthorized" }, 401);

  const admin = createClient(URL_, SVC, { auth: { persistSession: false } });

  // Check admin role
  const { data: isAdmin, error: rErr } = await admin.rpc("has_role", { _user_id: uid, _role: "admin" });
  if (rErr || !isAdmin) return j({ error: "forbidden" }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* noop */ }
  const action = String(body.action || "");

  try {
    if (action === "list") {
      const { data: users, error } = await admin.auth.admin.listUsers({ perPage: 200 });
      if (error) throw error;
      const ids = users.users.map((u) => u.id);
      const [{ data: roles }, { data: access }] = await Promise.all([
        admin.from("user_roles").select("user_id, role").in("user_id", ids),
        admin.from("user_page_access").select("user_id, section").in("user_id", ids),
      ]);
      const roleMap = new Map<string, string>();
      (roles ?? []).forEach((r) => roleMap.set(r.user_id, r.role));
      const secMap = new Map<string, string[]>();
      (access ?? []).forEach((a) => {
        const list = secMap.get(a.user_id) ?? [];
        list.push(a.section);
        secMap.set(a.user_id, list);
      });
      return j({
        users: users.users.map((u) => ({
          id: u.id,
          email: u.email,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at,
          role: roleMap.get(u.id) ?? "user",
          sections: secMap.get(u.id) ?? [],
        })),
      });
    }

    if (action === "invite" || action === "create") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const role = body.role === "admin" ? "admin" : "user";
      const rawSections = Array.isArray(body.sections) ? body.sections : ["market"];
      const sections = rawSections.filter((s): s is Section => SECTIONS.includes(s as Section));
      if (!email) return j({ error: "email_required" }, 400);
      if (!password || password.length < 8) return j({ error: "password_min_8" }, 400);

      const { data: created, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          created_by_admin: "true",
          requested_role: role,
          requested_sections: sections,
        },
      });
      if (error) return j({ error: error.message }, 400);
      return j({ user: created.user });
    }

    if (action === "update_role") {
      const targetId = String(body.user_id || "");
      const role = body.role === "admin" ? "admin" : "user";
      if (!targetId) return j({ error: "user_id_required" }, 400);
      await admin.from("user_roles").delete().eq("user_id", targetId);
      const { error } = await admin.from("user_roles").insert({ user_id: targetId, role });
      if (error) throw error;
      return j({ ok: true });
    }

    if (action === "update_access") {
      const targetId = String(body.user_id || "");
      const rawSections = Array.isArray(body.sections) ? body.sections : [];
      const sections = rawSections.filter((s): s is Section => SECTIONS.includes(s as Section));
      if (!targetId) return j({ error: "user_id_required" }, 400);
      await admin.from("user_page_access").delete().eq("user_id", targetId);
      if (sections.length) {
        const rows = sections.map((section) => ({ user_id: targetId, section }));
        const { error } = await admin.from("user_page_access").insert(rows);
        if (error) throw error;
      }
      return j({ ok: true });
    }

    if (action === "delete") {
      const targetId = String(body.user_id || "");
      if (!targetId) return j({ error: "user_id_required" }, 400);
      if (targetId === "2ff4497a-dedc-4885-98e5-435b26894275") {
        return j({ error: "cannot_delete_owner" }, 400);
      }
      const { error } = await admin.auth.admin.deleteUser(targetId);
      if (error) return j({ error: error.message }, 400);
      return j({ ok: true });
    }

    return j({ error: "unknown_action" }, 400);
  } catch (e) {
    return j({ error: (e as Error).message || "server_error" }, 500);
  }
});
