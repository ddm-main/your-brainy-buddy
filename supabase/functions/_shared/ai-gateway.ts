import { createOpenAICompatible } from "npm:@ai-sdk/openai-compatible";

const LOVABLE_AIG_RUN_ID_HEADER = "X-Lovable-AIG-Run-ID";
export { LOVABLE_AIG_RUN_ID_HEADER };

export function createLovableAiGatewayRunIdFetch(initialRunId?: string) {
  let runId = initialRunId?.trim() || undefined;
  let resolveRunId: (v: string | undefined) => void = () => {};
  let runIdResolved = false;
  const runIdReady = new Promise<string | undefined>((resolve) => { resolveRunId = resolve; });
  const publishRunId = (v?: string) => {
    const next = v?.trim() || undefined;
    if (!runId && next) runId = next;
    if (!runIdResolved) { runIdResolved = true; resolveRunId(runId); }
  };
  if (runId) publishRunId(runId);
  return {
    fetch: async (input: any, init?: any) => {
      const headers = new Headers(init?.headers);
      if (runId && !headers.has(LOVABLE_AIG_RUN_ID_HEADER)) {
        headers.set(LOVABLE_AIG_RUN_ID_HEADER, runId);
      }
      try {
        const response = await fetch(input, { ...init, headers });
        publishRunId(response.headers.get(LOVABLE_AIG_RUN_ID_HEADER) ?? undefined);
        return response;
      } catch (e) {
        publishRunId(undefined);
        throw e;
      }
    },
    getRunId: () => runId,
    waitForRunId: () => (runId ? Promise.resolve(runId) : runIdReady),
  };
}

export function createLovableAiGatewayProvider(
  lovableApiKey: string,
  initialRunId?: string,
) {
  const runIdFetch = createLovableAiGatewayRunIdFetch(initialRunId);
  const provider = createOpenAICompatible({
    name: "lovable",
    baseURL: "https://ai.gateway.lovable.dev/v1",
    headers: {
      "Lovable-API-Key": lovableApiKey,
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
    fetch: runIdFetch.fetch as any,
  });
  return Object.assign(provider, {
    getRunId: runIdFetch.getRunId,
    waitForRunId: runIdFetch.waitForRunId,
  });
}

export function getLovableAiGatewayRunId(request: Request): string | undefined {
  return request.headers.get(LOVABLE_AIG_RUN_ID_HEADER)?.trim() || undefined;
}

export function withLovableAiGatewayRunIdHeaders(
  baseHeaders: Record<string, string>,
  runId: string | undefined,
): Record<string, string> {
  const h = { ...baseHeaders };
  if (runId) h[LOVABLE_AIG_RUN_ID_HEADER] = runId;
  const exposed = new Set(
    (h["Access-Control-Expose-Headers"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  exposed.add(LOVABLE_AIG_RUN_ID_HEADER);
  h["Access-Control-Expose-Headers"] = Array.from(exposed).join(", ");
  return h;
}
