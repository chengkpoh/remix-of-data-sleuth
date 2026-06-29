import { createFileRoute } from "@tanstack/react-router";
import { ErpApp } from "@/components/erp/ErpApp";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ERP Data Finder" },
      {
        name: "description",
        content:
          "Universal SQL Server diagnostic tool. Locate unknown values across any ERP database — table, column, and data type agnostic.",
      },
      { property: "og:title", content: "ERP Data Finder" },
      {
        property: "og:description",
        content:
          "Connect to any Microsoft SQL Server database and search every table for a value across configurable column types.",
      },
    ],
  }),
  component: ErpApp,
  ssr: false,
});
