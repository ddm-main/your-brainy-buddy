// Pagination helper for PostgREST reads.
//
// WHY THIS EXISTS: Supabase's Data API enforces a hard server-side max-rows
// cap (1000 on this project). `.limit(3000)` does NOT return 3000 rows — it
// silently returns the first 1000 with no error, no truncation flag, and no
// warning. Every caller that assumed otherwise has been quietly operating on
// a partial universe:
//
//   * market-shares-outstanding-sync asked for 3000 active NSE symbols, got
//     the first 1000 alphabetically, and therefore never once attempted the
//     1,638 symbols sorting after "HONAUT" — which is why shares-outstanding
//     coverage flatlined at 909/2547 and every run reported 91/91 "failed".
//   * market-corp-actions-apply asked for 5000 unapplied corporate actions
//     and could silently skip the tail — splits/bonuses never applied.
//   * market-archive-prices asked for 20000 cold bars per symbol and would
//     archive only the oldest 1000, then delete beyond what it saved.
//
// Always route reads that can legitimately exceed 1000 rows through here.

// Structural stand-in for a PostgREST builder: all we need is that it is
// thenable and resolves to { data, error }. Typing it this way avoids a hard
// dependency on postgrest-js internals, which differ across SDK versions.
type PagedQuery<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

const PAGE_SIZE = 1000;

/**
 * Drains a PostgREST query across `.range()` pages until it is exhausted.
 *
 * @param build   Called once per page with the half-open row window. Must
 *                return a *fresh* builder each time (builders are one-shot)
 *                carrying identical filters and a deterministic `.order()` —
 *                without a stable sort, paging can repeat or skip rows.
 * @param maxRows Safety cap so a runaway table can't exhaust edge memory.
 */
export async function fetchAllRows<T>(
  build: (from: number, to: number) => PagedQuery<T>,
  maxRows = 50_000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, maxRows) - 1;
    const { data, error } = await build(from, to);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    // A short page means the result set is exhausted.
    if (rows.length < to - from + 1) break;
  }
  return out;
}

/**
 * Splits `values` into chunks small enough for a single `.in()` filter.
 * PostgREST puts `.in()` lists in the URL, so an unbounded list overflows the
 * request-line limit long before it overflows the row cap.
 */
export function chunked<T>(values: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}
