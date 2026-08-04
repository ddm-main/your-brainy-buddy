import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import ErrorBoundary from "@/components/hud/ErrorBoundary";
import { installEgressMeter } from "@/lib/egressMeter";
import "./styles.css";

// Measures the bytes of every Supabase response this tab receives and reports
// a per-route aggregate once a minute. It is the project's only source of
// truth for egress (Supabase no longer exposes it via the Management API).
installEgressMeter();


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
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
