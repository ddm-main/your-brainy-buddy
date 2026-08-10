// Build guard — stops stale tabs from polling forever.
//
// A tab left open across a deploy keeps running the bundle it loaded. That is
// how a screener session from before the static/live column split kept issuing
// a single 108-column, 872 KB query 162 times in one day (141 MB of PostgREST
// egress, 95% of the project total) long after the split had shipped.
//
// This polls `index.html` for the hashed entry-script name and hard-reloads
// when it changes, so an old bundle can never outlive a deploy by more than
// one check interval.

const CHECK_MS = 10 * 60_000;
const RELOAD_FLAG = "buildGuard.reloadedFor";

function signatureFromSources(srcs: string[]): string | null {
  const normalized = srcs
    .map((src) => {
      try { return new URL(src, window.location.origin).pathname; }
      catch { return src; }
    })
    .sort();
  return normalized.length > 0 ? normalized.join("|") : null;
}

/** Entry scripts loaded by this document, before a newer index is fetched. */
function currentEntrySignature(): string | null {
  return signatureFromSources(
    [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')]
      .map((script) => script.getAttribute("src"))
      .filter((src): src is string => Boolean(src)),
  );
}

/** The hashed module scripts referenced by the served index.html. */
async function fetchEntrySignature(): Promise<string | null> {
  try {
    // `cache: no-store` matters — a cached index.html would report the old
    // bundle forever and the guard would never fire.
    const res = await fetch(`${window.location.origin}/index.html`, { cache: "no-store" });
    if (!res.ok) return null;
    const html = await res.text();
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    return signatureFromSources(srcs);
  } catch {
    return null; // offline or blocked — never reload on a failed check
  }
}

export function installBuildGuard() {
  if (typeof window === "undefined") return;
  if ((window as any).__buildGuard) return;
  (window as any).__buildGuard = true;

  // In dev the entry is unhashed and HMR handles updates, so the guard would
  // either never fire or fight the dev server.
  if (import.meta.env.DEV) return;

  // Start with what this tab actually loaded. Using the first network response
  // as the baseline lets an already-stale tab silently adopt the new build and
  // continue polling with its old JavaScript until another deployment.
  let baseline = currentEntrySignature();

  const check = async () => {
    const sig = await fetchEntrySignature();
    if (!sig) return;
    if (baseline === null) { baseline = sig; return; }
    if (sig === baseline) return;

    // Guard against a reload loop when index.html and the deployed assets
    // disagree (mid-deploy, or a CDN serving mixed versions): only ever
    // reload once per observed signature.
    if (sessionStorage.getItem(RELOAD_FLAG) === sig) return;
    sessionStorage.setItem(RELOAD_FLAG, sig);

    // eslint-disable-next-line no-console
    console.warn("[buildGuard] newer build detected — reloading to drop the stale bundle");
    window.location.reload();
  };

  void check();
  setInterval(() => { void check(); }, CHECK_MS);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
}
