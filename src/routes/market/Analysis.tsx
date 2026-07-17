import { useParams } from "react-router-dom";
import Scaffold from "./_Scaffold";
export default function Analysis() {
  const { symbol } = useParams();
  return <Scaffold title={symbol ? `Analysis · ${symbol}` : "Stock Analysis"} index="MK.ANL" blurb="Interactive TradingView charts, technicals, breakout probability, support/resistance, financials, peers, news and AI summary per symbol." />;
}
