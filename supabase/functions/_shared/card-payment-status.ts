// Card payment-lifecycle state machine, split out from finance-extract-core
// so it can be imported by Node/vitest tests without pulling the heavy
// Deno `npm:` deps that live in the extract core.

export function computeCardPaymentStatus(
  currentStatus: string | null,
  paidAmount: number,
  totalDue: number | null | undefined,
  dueDate: string | null | undefined,
): "na" | "pending" | "paid" | "overdue" | "partial" {
  if (currentStatus === "paid" || currentStatus === "partial") return currentStatus as any;
  if (!dueDate) return "na";
  const total = Number(totalDue ?? 0);
  if (total > 0 && paidAmount >= total) return "paid";
  const today = new Date().toISOString().slice(0, 10);
  if (dueDate < today && (total === 0 || paidAmount < total)) return "overdue";
  if (paidAmount > 0 && total > 0 && paidAmount < total) return "partial";
  return "pending";
}