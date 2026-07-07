import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { listThreads, createThread } from "@/lib/threads.functions";

export const Route = createFileRoute("/_authenticated/")({
  beforeLoad: async () => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) return;
    const threads = await listThreads();
    if (threads.length > 0) {
      throw redirect({ to: "/$threadId", params: { threadId: threads[0].id } });
    }
    const t = await createThread({ data: {} });
    throw redirect({ to: "/$threadId", params: { threadId: t.id } });
  },
  component: () => null,
});
