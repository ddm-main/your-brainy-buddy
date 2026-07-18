// Embedded TradingView Advanced Chart widget, dark-themed to blend with the HUD.
// Loads TradingView's official embed script into a container; the widget renders
// its own iframe with the full TV toolbar (drawings, studies, intervals).
import { useEffect, useRef } from "react";

const EMBED_SRC = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

// Map the app's timeframe labels to TradingView interval codes.
export function tvInterval(tf: string): string {
  switch (tf) {
    case "1D": return "D";
    case "1h": return "60";
    case "15m": return "15";
    case "5m": return "5";
    default: return "D";
  }
}

export function TradingViewChart({
  symbol,
  // BSE, not NSE: NSE is not licensed for TradingView widgets (renders
  // "symbol doesn't exist"), while BSE is available at EOD level. Large-cap
  // tickers are dual-listed on BSE with the same symbol.
  exchange = "BSE",
  interval,
}: {
  symbol: string;
  exchange?: string;
  interval: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    container.innerHTML = '<div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>';

    const script = document.createElement("script");
    script.src = EMBED_SRC;
    script.async = true;
    script.type = "text/javascript";
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: `${exchange}:${symbol}`,
      interval,
      timezone: "Asia/Kolkata",
      theme: "dark",
      style: "1",
      locale: "en",
      allow_symbol_change: false,
      hide_side_toolbar: false,
      withdateranges: true,
      backgroundColor: "rgba(4,16,22,1)",
      gridColor: "rgba(53,214,237,0.06)",
      support_host: "https://www.tradingview.com",
    });
    container.appendChild(script);

    return () => { container.innerHTML = ""; };
  }, [symbol, exchange, interval]);

  return (
    <div
      ref={ref}
      className="tradingview-widget-container"
      style={{ height: "100%", width: "100%" }}
    />
  );
}

export default TradingViewChart;
