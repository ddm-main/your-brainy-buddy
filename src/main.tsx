import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import ErrorBoundary from "@/components/hud/ErrorBoundary";
import EgressApprovalGate from "@/components/hud/EgressApprovalGate";

import { installEgressMeter } from "@/lib/egressMeter";
import { installBuildGuard } from "@/lib/buildGuard";
import "./styles.css";

// Measures the bytes of every Supabase response this tab receives and reports
// a per-route aggregate once a minute. It is the project's only source of
// truth for egress (Supabase no longer exposes it via the Management API).
installEgressMeter();

// A tab left open across a deploy keeps polling with its old bundle. That is
// what produced 141 MB of egress in a single day from one pre-split screener
// session, so stale bundles are now retired on the next check.
installBuildGuard();



const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
        <EgressApprovalGate />

      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
