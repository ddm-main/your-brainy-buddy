// Shared Indian-bank combobox. Typeahead across the bundled INDIAN_BANKS
// list unioned with existing `public.banks` rows. Selecting a bundled name
// that has no DB row yet upserts (case-insensitive dedupe via the
// banks_name_lower_uidx unique index) and returns the new row's id via
// onChange. Used by AccountsConfig, CardsConfig, and the Statements upload
// flow.

import { useEffect, useMemo, useRef, useState } from "react";
import { db, type Bank } from "@/lib/db";
import { INDIAN_BANKS } from "@/data/indianBanks";
import { inputStyle } from "@/components/hud/HudControls";

interface Props {
  value: string;                         // bank_id
  onChange: (bankId: string, name: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export default function BankPicker({ value, onChange, placeholder = "type or pick a bank", disabled }: Props) {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { db.banks.list().then(setBanks).catch(() => {}); }, []);

  // Reflect the selected id back into the visible input.
  useEffect(() => {
    if (!value) { setQuery(""); return; }
    const found = banks.find((b) => b.id === value);
    if (found) setQuery(found.name);
  }, [value, banks]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const options = useMemo(() => {
    const bySlug = new Map<string, { id?: string; name: string; existing: boolean }>();
    for (const b of banks) bySlug.set(b.name.toLowerCase(), { id: b.id, name: b.name, existing: true });
    for (const name of INDIAN_BANKS) {
      const k = name.toLowerCase();
      if (!bySlug.has(k)) bySlug.set(k, { name, existing: false });
    }
    const list = Array.from(bySlug.values());
    const q = query.trim().toLowerCase();
    const filtered = q ? list.filter((o) => o.name.toLowerCase().includes(q)) : list;
    filtered.sort((a, b) => {
      // existing rows first, then alphabetical
      if (a.existing !== b.existing) return a.existing ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return filtered.slice(0, 40);
  }, [banks, query]);

  const pick = async (opt: { id?: string; name: string; existing: boolean }) => {
    setOpen(false);
    setQuery(opt.name);
    if (opt.existing && opt.id) { onChange(opt.id, opt.name); return; }
    setBusy(true);
    try {
      const created = await db.banks.create(opt.name);
      setBanks((prev) => (prev.some((p) => p.id === created.id) ? prev : [...prev, created]));
      onChange(created.id, created.name);
    } catch {
      // fallback: look up by name in case a race created it
      const list = await db.banks.list();
      setBanks(list);
      const found = list.find((b: Bank) => b.name.toLowerCase() === opt.name.toLowerCase());
      if (found) onChange(found.id, found.name);
    } finally { setBusy(false); }
  };

  const trimmed = query.trim();
  const showCreate = trimmed && !options.some((o) => o.name.toLowerCase() === trimmed.toLowerCase());

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        value={query}
        disabled={disabled || busy}
        placeholder={placeholder}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        style={{ ...inputStyle, width: "100%" }}
      />
      {open && (
        <div style={{
          position: "absolute", zIndex: 30, left: 0, right: 0, top: "100%",
          background: "var(--bg, #0b1117)", border: "1px solid var(--edge-strong)",
          maxHeight: 240, overflowY: "auto", marginTop: 2,
        }}>
          {options.map((o) => (
            <button
              key={o.name}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                width: "100%", textAlign: "left", padding: "6px 10px",
                background: "transparent", border: "none", cursor: "pointer",
                color: "var(--text)", fontSize: 12,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(53,214,237,0.06)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span>{o.name}</span>
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{o.existing ? "saved" : "add"}</span>
            </button>
          ))}
          {showCreate && (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); pick({ name: trimmed, existing: false }); }}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: "6px 10px",
                background: "rgba(53,214,237,0.04)", border: "none", cursor: "pointer",
                color: "var(--accent)", fontSize: 12,
              }}
            >+ add "{trimmed}"</button>
          )}
          {options.length === 0 && !showCreate && (
            <div style={{ padding: "6px 10px", fontSize: 12, color: "var(--text-muted)" }}>no matches</div>
          )}
        </div>
      )}
    </div>
  );
}
