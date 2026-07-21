// Symbol autocomplete — typeahead against market_data (the synced tradable
// universe), matching on symbol prefix or company name. Drop-in replacement
// for a plain <input>; the caller keeps its own label/flex wrapper and just
// swaps the element.
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { inputStyle as baseInputStyle } from "@/components/hud/HudControls";

export type SymbolOption = { symbol: string; exchange: string; company_name: string | null };

export function SymbolSearchInput({
  value, onChange, onSelect, onEnter, exchange, placeholder, autoFocus, id,
  containerStyle, inputStyle: inputStyleOverride,
}: {
  value: string;
  onChange: (v: string) => void;
  onSelect?: (opt: SymbolOption) => void;
  // Fired on Enter when no suggestion is highlighted — lets the caller fall
  // back to its own "navigate/submit with raw typed text" behavior.
  onEnter?: () => void;
  exchange?: string;
  placeholder?: string;
  autoFocus?: boolean;
  id?: string;
  containerStyle?: React.CSSProperties;
  inputStyle?: React.CSSProperties;
}) {
  const [options, setOptions] = useState<SymbolOption[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const reqSeq = useRef(0);

  useEffect(() => {
    // Strip anything that'd break PostgREST's .or() list syntax (commas,
    // parens) — plain alnum/space is all a symbol or company name needs.
    const term = value.trim().toUpperCase().replace(/[^A-Z0-9 ]/g, "");
    if (!term) { setOptions([]); return; }
    const seq = ++reqSeq.current;
    const t = setTimeout(async () => {
      let q = supabase.from("market_data")
        .select("symbol,exchange,company_name")
        .eq("is_active", true)
        .or(`symbol.ilike.${term}%,company_name.ilike.%${term}%`)
        .limit(8);
      if (exchange) q = q.eq("exchange", exchange);
      const { data } = await q;
      if (seq !== reqSeq.current) return; // stale response — a newer keystroke already fired
      const rows = (data ?? []) as SymbolOption[];
      rows.sort((a, b) => {
        const aStarts = a.symbol.startsWith(term) ? 0 : 1;
        const bStarts = b.symbol.startsWith(term) ? 0 : 1;
        return aStarts - bStarts || a.symbol.localeCompare(b.symbol);
      });
      setOptions(rows);
      setHighlighted(-1);
    }, 200);
    return () => clearTimeout(t);
  }, [value, exchange]);

  const selectOption = (opt: SymbolOption) => {
    onChange(opt.symbol);
    onSelect?.(opt);
    setOpen(false);
    setOptions([]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || options.length === 0) {
      if (e.key === "Enter") onEnter?.();
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted((h) => Math.min(h + 1, options.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlighted((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Escape") { setOpen(false); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (highlighted >= 0) selectOption(options[highlighted]);
      else onEnter?.();
    }
  };

  return (
    <div style={{ position: "relative", ...containerStyle }}>
      <input
        id={id}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        style={{ ...baseInputStyle, width: "100%", ...inputStyleOverride }}
      />
      {open && options.length > 0 && (
        <div
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: "absolute", top: "calc(100% + 2px)", left: 0, right: 0, zIndex: 50,
            background: "var(--bg)", border: "1px solid var(--edge-strong)",
            maxHeight: 220, overflowY: "auto",
          }}
        >
          {options.map((o, i) => (
            <div key={`${o.exchange}:${o.symbol}`}
              onClick={() => selectOption(o)}
              onMouseEnter={() => setHighlighted(i)}
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
                padding: "6px 8px", fontSize: 12, cursor: "pointer",
                background: i === highlighted ? "rgba(53,214,237,0.1)" : "transparent",
              }}
            >
              <span>
                <span style={{ color: "var(--accent)" }}>{o.symbol}</span>
                {o.company_name && <span style={{ color: "var(--text-dim)", marginLeft: 6, fontSize: 10 }}>{o.company_name}</span>}
              </span>
              <span style={{ color: "var(--text-muted)", fontSize: 10 }}>{o.exchange}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
