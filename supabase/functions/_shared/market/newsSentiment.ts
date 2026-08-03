// Headline sentiment for market_news. Deliberately a small, deterministic
// lexicon rather than an LLM call: news sync runs over the whole universe and
// an AI call per headline would be both slow and expensive, while the signal
// we need ("is this good or bad for the stock?") is carried by a handful of
// well-known phrases in Indian market headlines.
//
// Returns a score in −1..+1 and a coarse impact label. Used at sync time to
// populate market_news.sentiment / .impact, in the v4 sentiment bucket, and by
// the UI as a fallback for rows synced before classification existed.

const BULLISH: Array<[RegExp, number]> = [
  [/\bwins?\b|\bbags?\b|\bsecures?\b/i, 0.6],
  [/\border(s)? (worth|from|win)|\bcontract\b|\bloi\b/i, 0.5],
  [/\bprofit (up|rises?|jumps?|surges?|doubles?)\b|\bpat (up|rises?)\b/i, 0.8],
  [/\brevenue (up|rises?|grows?|jumps?)\b|\bsales (up|rises?|jumps?)\b/i, 0.6],
  [/\brecord (high|profit|revenue|quarter)\b|\ball-time high\b/i, 0.7],
  [/\bupgrade[sd]?\b|\braises? target\b|\btarget price hiked?\b|\bbuy rating\b|\boutperform\b/i, 0.7],
  [/\bstake (buy|purchase|increase[sd]?|raise[sd]?|hike[sd]?)\b|\bincreases? .*stake\b|\bacquires? stake\b/i, 0.4],
  [/\bdividend\b|\bbonus issue\b|\bbuyback\b|\bstock split\b/i, 0.35],
  [/\bexpansion\b|\bnew plant\b|\bcapacity addition\b|\bcapex\b/i, 0.3],
  [/\bapproval\b|\bapproved\b|\bclearance\b|\blicen[cs]e granted\b/i, 0.4],
  [/\bpartnership\b|\btie-?up\b|\bjoint venture\b|\bmou\b/i, 0.3],
  [/\bturnaround\b|\bdebt (free|reduction|reduced)\b/i, 0.5],
  [/\bsurges?\b|\brallys?\b|\brallies\b|\bjumps?\b|\bsoars?\b|\bhits upper circuit\b/i, 0.45],
];

const BEARISH: Array<[RegExp, number]> = [
  [/\bfraud\b|\bscam\b|\bprobe\b|\binvestigation\b|\braid(s|ed)?\b/i, -0.9],
  [/\bpenalt(y|ies)\b|\bfine[sd]?\b|\bshow cause\b|\bnotice from\b/i, -0.6],
  [/\bdowngrade[sd]?\b|\bcuts? target\b|\bsell rating\b|\bunderperform\b/i, -0.7],
  [/\bloss (widens?|rises?)\b|\bposts? loss\b|\bnet loss\b|\bslips? into loss\b/i, -0.8],
  [/\bprofit (down|falls?|drops?|declines?|slumps?|plunges?)\b/i, -0.7],
  [/\brevenue (down|falls?|declines?)\b|\bsales (down|falls?|declines?)\b/i, -0.6],
  [/\bdefault(s|ed)?\b|\binsolvency\b|\bnclt\b|\bbankrupt(cy)?\b/i, -0.9],
  [/\bresign(s|ed|ation)\b|\bsteps down\b|\bexits? as (ceo|cfo|md)\b/i, -0.5],
  [/\bstake (sale|sold|cut|pared?|reduce[sd]?)\b|\bsells? .*stake\b|\bpledged? shares\b/i, -0.45],
  [/\bplunges?\b|\bcrash(es)?\b|\bslumps?\b|\btumbles?\b|\bhits lower circuit\b/i, -0.5],
  [/\bstrike\b|\bshutdown\b|\bplant halt(ed)?\b|\brecall\b|\bfire at\b/i, -0.6],
  [/\bdelay(s|ed)?\b|\bdeferred?\b|\bcancel(s|led|ed)?\b/i, -0.35],
  [/\bdowngrades? outlook\b|\bguidance cut\b|\bwarns?\b/i, -0.6],
];

// "no fraud found", "loss narrows" etc. must not read as bearish.
const NEGATORS = /\b(no|not|denies|denied|rules out|narrows?|narrowed|clears?|cleared of|dismissed)\b/i;

export interface HeadlineSentiment {
  /** −1..+1 */
  score: number;
  impact: "positive" | "negative" | "neutral";
  /** Matched phrases, for tooltips / debugging. */
  hits: string[];
}

export function classifyHeadline(headline: string | null | undefined): HeadlineSentiment {
  const text = String(headline ?? "");
  if (!text.trim()) return { score: 0, impact: "neutral", hits: [] };
  const hits: string[] = [];
  let raw = 0;
  for (const [re, w] of [...BULLISH, ...BEARISH]) {
    const m = text.match(re);
    if (!m) continue;
    hits.push(m[0]);
    raw += w;
  }
  // A negation flips the sign of the strongest signal rather than zeroing the
  // headline — "profit does not fall" is mildly positive, not neutral.
  if (raw !== 0 && NEGATORS.test(text)) raw = -raw * 0.6;
  // Squash so several weak matches can't run away past ±1.
  const score = Math.max(-1, Math.min(1, raw / 1.5));
  const impact = score >= 0.15 ? "positive" : score <= -0.15 ? "negative" : "neutral";
  return { score: Number(score.toFixed(3)), impact, hits };
}

export interface NewsWindowSentiment {
  /** Average score across classified headlines, −1..+1. Null when none. */
  avg: number | null;
  count: number;
  positive: number;
  negative: number;
}

// Recency-weighted average over a news window. Newer headlines dominate: a
// three-week-old upgrade should not outweigh yesterday's profit warning.
export function windowSentiment(
  items: Array<{ sentiment?: number | null; headline?: string | null; published_at?: string | null }>,
  now = Date.now(),
): NewsWindowSentiment {
  let wSum = 0, sum = 0, count = 0, positive = 0, negative = 0;
  for (const it of items) {
    const s = it.sentiment != null && Number.isFinite(it.sentiment)
      ? Number(it.sentiment)
      : classifyHeadline(it.headline).score;
    count++;
    if (s >= 0.15) positive++;
    else if (s <= -0.15) negative++;
    const ageDays = it.published_at ? (now - new Date(it.published_at).getTime()) / 86_400_000 : 7;
    const w = 1 / (1 + Math.max(0, ageDays) / 10);
    wSum += w;
    sum += s * w;
  }
  return { avg: wSum > 0 ? Number((sum / wSum).toFixed(3)) : null, count, positive, negative };
}
