// GTT — Good-Till-Triggered orders. Watched server-side by market-gtt-eval;
// this page is CRUD + status view for the GTT table.
import { useMemo, useState } from "react";
import { HudPanel } from "@/components/hud/HudPanel";
import { Btn, Chip, EmptyState, inputStyle, labelStyle } from "@/components/hud/HudControls";
import { DataTable, fmtNum } from "@/components/hud/DataTable";
import { SymbolSearchInput } from "@/components/market/SymbolSearchInput";
import { useMarketSettings } from "@/lib/market/hooks";
import { useGttMutations, useGttOrders, type GttOrder, type PlaceGttInput } from "@/lib/market/gttHooks";
import { useUi } from "@/store/uiStore";
import { toSafeError } from "@/lib/errors";
import { relTime } from "@/lib/relTime";
import { Plus, Trash2, X } from "lucide-react";

const emptyDraft: PlaceGttInput = {
  symbol: "", exchange: "NSE", side: "BUY", triggerType: "single",
  triggerPrice: 0, orderType: "LIMIT", price: undefined, quantity: 1, product: "CNC",
};

export default function GTT() {
  const push = useUi((s) => s.push);
  const { data: gtts = [], isLoading } = useGttOrders();
  const { data: settings = [] } = useMarketSettings();
  const { place, cancel } = useGttMutations();
  const [draft, setDraft] = useState<PlaceGttInput | null>(null);

  const connected = settings.some((s) => s.active_provider === "kotak_neo" && s.connection_status === "connected");
  const active = useMemo(() => gtts.filter((g) => g.status === "active"), [gtts]);
  const done = useMemo(() => gtts.filter((g) => g.status !== "active"), [gtts]);

  const submit = () => {
    if (!draft) return;
    if (!draft.symbol.trim()) { push("Symbol required", "warn"); return; }
    if (!(Number(draft.triggerPrice) > 0)) { push("Trigger price must be positive", "warn"); return; }
    if (draft.orderType === "LIMIT" && !(Number(draft.price) > 0)) { push("Limit price required for LIMIT GTT", "warn"); return; }
    if (draft.triggerType === "OCO" && !(Number(draft.triggerPriceUpper) > (draft.triggerPrice))) {
      push("Upper trigger must be greater than lower trigger for OCO", "warn"); return;
    }
    place.mutate(draft, {
      onSuccess: () => { push("GTT created", "ok"); setDraft(null); },
      onError: (e) => push(toSafeError(e, "Failed to create GTT").message, "err"),
    });
  };

  const columns = useMemo(() => [
    {
      header: "Symbol", accessorKey: "symbol" as const,
      cell: ({ row }: { row: { original: GttOrder } }) => (
        <span>
          <Chip tone={row.original.side === "BUY" ? "ok" : "warn"}>{row.original.side}</Chip>
          <span style={{ marginLeft: 6 }}>{row.original.symbol}</span>
          <span style={{ color: "var(--text-dim)", marginLeft: 6, fontSize: 10 }}>{row.original.exchange}</span>
        </span>
      ),
    },
    { header: "Type", accessorKey: "trigger_type" as const },
    { header: "Trigger", accessorKey: "trigger_price" as const, meta: { align: "right" as const }, cell: ({ row }: { row: { original: GttOrder } }) => (
      <span>{fmtNum(row.original.trigger_price)}{row.original.trigger_price_upper ? ` / ${fmtNum(row.original.trigger_price_upper)}` : ""}</span>
    ) },
    { header: "Order", id: "order", cell: ({ row }: { row: { original: GttOrder } }) => (
      <span>{row.original.order_type} × {row.original.quantity} {row.original.price ? `@ ₹${fmtNum(row.original.price)}` : ""} ({row.original.product})</span>
    ) },
    { header: "Status", accessorKey: "status" as const, cell: ({ row }: { row: { original: GttOrder } }) => (
      <Chip tone={row.original.status === "active" ? "ok" : row.original.status === "triggered" ? "neutral" : row.original.status === "failed" ? "err" : "warn"}>
        {row.original.status}{row.original.triggered_leg ? ` (${row.original.triggered_leg})` : ""}
      </Chip>
    ) },
    { header: "Created", accessorKey: "created_at" as const, meta: { align: "right" as const },
      cell: ({ row }: { row: { original: GttOrder } }) => <span style={{ color: "var(--text-dim)" }}>{relTime(row.original.created_at)} ago</span> },
    { header: "", id: "actions", meta: { align: "right" as const },
      cell: ({ row }: { row: { original: GttOrder } }) => row.original.status === "active" ? (
        <button className="hud-btn" data-variant="ghost" data-size="sm" title="Cancel GTT"
          onClick={() => { if (confirm(`Cancel GTT for ${row.original.symbol}?`)) cancel.mutate(row.original.id, { onError: (e) => push(toSafeError(e, "Cancel failed").message, "err") }); }}>
          <Trash2 size={11} />
        </button>
      ) : null },
  ], [cancel, push]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <HudPanel flow title="GTT Orders" index="MK.GTT.01" actions={
        <Btn size="sm" variant="primary" onClick={() => setDraft({ ...emptyDraft })}>
          <Plus size={11} style={{ marginRight: 4 }} />new GTT
        </Btn>
      }>
        {!connected && (
          <div style={{ padding: 8, marginBottom: 8, border: "1px solid var(--warn)", color: "var(--warn)", fontSize: 11 }}>
            Kotak Neo not connected — GTTs will be watched but the real order will fail to place on trigger.
          </div>
        )}
        {active.length === 0 ? (
          <EmptyState hint="Create a GTT to place an order when price crosses your trigger">no active GTTs</EmptyState>
        ) : (
          <DataTable columns={columns as any} data={active} emptyLabel="no active GTTs" />
        )}
      </HudPanel>

      {done.length > 0 && (
        <HudPanel flow title="History" index="MK.GTT.02">
          <DataTable columns={columns as any} data={done} emptyLabel="—" />
        </HudPanel>
      )}

      {isLoading && <div className="hud-label">loading…</div>}

      {draft && (
        <div onClick={() => setDraft(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 96vw)", background: "var(--bg)", border: "1px solid var(--edge-strong)", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div className="hud-label" style={{ color: "var(--accent)", letterSpacing: "0.2em" }}>New GTT</div>
              <button onClick={() => setDraft(null)} className="hud-btn" data-variant="ghost" data-size="sm"><X size={14} /></button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <div style={labelStyle}>Symbol</div>
                <SymbolSearchInput value={draft.symbol} onChange={(v) => setDraft({ ...draft, symbol: v.toUpperCase() })}
                  onSelect={(o) => setDraft({ ...draft, symbol: o.symbol, exchange: o.exchange as "NSE" | "BSE" })}
                  exchange={draft.exchange} placeholder="RELIANCE" />
              </div>
              <div>
                <div style={labelStyle}>Exchange</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {(["NSE", "BSE"] as const).map((ex) => (
                    <Btn key={ex} size="sm" variant={draft.exchange === ex ? "primary" : "ghost"} onClick={() => setDraft({ ...draft, exchange: ex })}>{ex}</Btn>
                  ))}
                </div>
              </div>
              <div>
                <div style={labelStyle}>Side</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {(["BUY", "SELL"] as const).map((s) => (
                    <Btn key={s} size="sm" variant={draft.side === s ? "primary" : "ghost"} onClick={() => setDraft({ ...draft, side: s })}>{s}</Btn>
                  ))}
                </div>
              </div>
              <div>
                <div style={labelStyle}>Trigger type</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {(["single", "OCO"] as const).map((t) => (
                    <Btn key={t} size="sm" variant={draft.triggerType === t ? "primary" : "ghost"} onClick={() => setDraft({ ...draft, triggerType: t })}>{t}</Btn>
                  ))}
                </div>
              </div>
              <div>
                <div style={labelStyle}>Trigger price {draft.triggerType === "OCO" ? "(lower)" : ""}</div>
                <input type="number" value={draft.triggerPrice || ""} onChange={(e) => setDraft({ ...draft, triggerPrice: Number(e.target.value) })} style={{ ...inputStyle, width: "100%" }} />
              </div>
              {draft.triggerType === "OCO" && (
                <div>
                  <div style={labelStyle}>Trigger price (upper)</div>
                  <input type="number" value={draft.triggerPriceUpper ?? ""} onChange={(e) => setDraft({ ...draft, triggerPriceUpper: e.target.value ? Number(e.target.value) : undefined })} style={{ ...inputStyle, width: "100%" }} />
                </div>
              )}
              <div>
                <div style={labelStyle}>Order type</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {(["LIMIT", "MARKET"] as const).map((o) => (
                    <Btn key={o} size="sm" variant={draft.orderType === o ? "primary" : "ghost"} onClick={() => setDraft({ ...draft, orderType: o })}>{o}</Btn>
                  ))}
                </div>
              </div>
              {draft.orderType === "LIMIT" && (
                <div>
                  <div style={labelStyle}>Limit price</div>
                  <input type="number" value={draft.price ?? ""} onChange={(e) => setDraft({ ...draft, price: e.target.value ? Number(e.target.value) : undefined })} style={{ ...inputStyle, width: "100%" }} />
                </div>
              )}
              <div>
                <div style={labelStyle}>Quantity</div>
                <input type="number" value={draft.quantity || ""} onChange={(e) => setDraft({ ...draft, quantity: Number(e.target.value) })} style={{ ...inputStyle, width: "100%" }} />
              </div>
              <div>
                <div style={labelStyle}>Product</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {(["CNC", "MIS", "NRML"] as const).map((p) => (
                    <Btn key={p} size="sm" variant={draft.product === p ? "primary" : "ghost"} onClick={() => setDraft({ ...draft, product: p })}>{p}</Btn>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <Btn onClick={() => setDraft(null)}>cancel</Btn>
              <Btn variant="primary" onClick={submit} disabled={place.isPending}>{place.isPending ? "placing…" : "create GTT"}</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
