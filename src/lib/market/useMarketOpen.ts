// Live "is the NSE cash session open right now" flag. Re-evaluates every 30s
// so panels gated on market hours appear/disappear on their own at 09:15/15:30
// without a reload.
import { useEffect, useState } from "react";
import { nseOpenNow } from "@/lib/market/liveTickStore";

export function useMarketOpen(): boolean {
  const [open, setOpen] = useState(() => nseOpenNow());
  useEffect(() => {
    const id = setInterval(() => setOpen(nseOpenNow()), 30_000);
    return () => clearInterval(id);
  }, []);
  return open;
}
