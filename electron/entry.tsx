import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../src/styles.css";
import { ErpApp } from "../src/components/erp/ErpApp";
import { Toaster } from "../src/components/ui/sonner";

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErpApp />
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);
