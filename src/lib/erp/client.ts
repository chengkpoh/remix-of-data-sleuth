import type { ErpApi } from "./types";

export function getErp(): ErpApi | null {
  if (typeof window === "undefined") return null;
  return window.erp ?? null;
}

export function isElectron(): boolean {
  return !!getErp()?.isElectron;
}

export function requireErp(): ErpApi {
  const api = getErp();
  if (!api) {
    throw new Error(
      "SQL Server access is only available in the ERP Data Finder desktop app. " +
        "Run `npm run electron:dev` locally, or package with `npm run electron:pack`.",
    );
  }
  return api;
}