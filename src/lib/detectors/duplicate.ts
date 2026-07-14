import type { DetectorTxn } from "./salary";
import { normalizeMerchant } from "@/lib/merchant";

export interface DuplicateHit {
  keepId: string;
  duplicateId: string;
  amount: number;
  merchant: string;
  daysApart: number;
}

/** Same-amount + ±2d + overlapping normalized merchant, across different sources. */
export function detectDuplicates(txns: DetectorTxn[]): DuplicateHit[] {
  const out: DuplicateHit[] = [];
  const sorted = [...txns].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i], b = sorted[j];
      const dayDiff = Math.abs(
        (new Date(b.txn_date).getTime() - new Date(a.txn_date).getTime()) / 86_400_000,
      );
      if (dayDiff > 2) break;
      if (a.txn_type !== b.txn_type) continue;
      if (Number(a.amount) !== Number(b.amount)) continue;
      const ma = normalizeMerchant(a.merchant ?? a.description);
      const mb = normalizeMerchant(b.merchant ?? b.description);
      if (!ma || !mb) continue;
      if (!(ma === mb || ma.includes(mb) || mb.includes(ma))) continue;
      if ((a as any).source && (b as any).source && (a as any).source === (b as any).source) continue;
      out.push({
        keepId: a.id,
        duplicateId: b.id,
        amount: Number(a.amount),
        merchant: a.merchant ?? ma,
        daysApart: Math.round(dayDiff),
      });
    }
  }
  return out;
}