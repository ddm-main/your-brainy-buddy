// Symbol autocomplete — typeahead against market_stocks (the synced tradable
// universe), matching on symbol prefix or company name. Renders the dropdown
// via a portal with fixed positioning so ancestor `overflow: hidden` on HUD
// panels can't clip the suggestion list.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/integrations/supabase/client";
import { inputStyle as baseInputStyle } from "@/components/hud/HudControls";

export type SymbolOption = { symbol: string; exchange: string; company_name: string | null };

export function SymbolSearchInput({
  value, onChange, onSelect, onEnter, exchange, placeholder, autoFocus, id, disabled,
  containerStyle, inputStyle: inputStyleOverride,
}: {
  value: string;
  onChange: (v: string) => void;
  onSelect?: (opt: SymbolOption) => void;
  onEnter?: () => void;
  exchange?: string;
  placeholder?: string;
  autoFocus?: boolean;
  id?: string;
  disabled?: boolean;
  containerStyle?: React.CSSProperties;
  inputStyle?: React.CSSProperties;
}) {
  const [options, setOptions] = useState<SymbolOption[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const reqSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const term = value.trim().toUpperCase().replace(/[^A-Z0-9 ]/g, "");
    if (!term) { setOptions([]); return; }
    const seq = ++reqSeq.current;
    const t = setTimeout(async () => {
      let q = supabase.from("market_stocks")
        .select("symbol,exchange,company_name")
        .eq("is_active", true)
        .or(`symbol.ilike.${term}%,company_name.ilike.%${term}%`)
        .limit(10);
      if (exchange) q = q.eq("exchange", exchange);
      const { data } = await q;
      if (seq !== reqSeq.current) return;
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

  const updateRect = () => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, top: r.bottom + 2, width: r.width });
  };

  useLayoutEffect(() => {
    if (!open || options.length === 0) return;
    updateRect();
    const onScroll = () => updateRect();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, options.length]);

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
        ref={inputRef}
        id={id}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        disabled={disabled}
        style={{ ...baseInputStyle, width: "100%", opacity: disabled ? 0.6 : 1, ...inputStyleOverride }}
      />
      {open && options.length > 0 && rect && createPortal(
        <div
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: "fixed", left: rect.left, top: rect.top, width: rect.width, zIndex: 1000,
            background: "var(--bg)", border: "1px solid var(--edge-strong)",
            maxHeight: 320, overflowY: "auto",
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
        </div>,
        document.body
      )}
    </div>
  );
}
