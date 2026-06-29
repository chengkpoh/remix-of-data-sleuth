# ERP Data Finder — running the desktop build

The web preview in Lovable shows the full UI but cannot reach a SQL Server
(browsers and edge runtimes can't open TCP to MSSQL). Real database access
lives in the Electron main process (`electron/main.cjs`), which uses the
`mssql` Node driver.

## One-time setup (local)

```bash
npm install
npm install --save-dev electron mssql concurrently wait-on @electron/packager
```

`electron`, `mssql`, `concurrently`, `wait-on`, and `@electron/packager`
aren't installed in the Lovable sandbox to keep it light — install them on
your machine.

## Develop with hot reload

```bash
npm run electron:dev
```

This starts `vite dev` on http://localhost:8080 and launches Electron once
it's ready, loading the dev server. Edits to React code hot-reload; edits
to `electron/main.cjs` require restarting Electron.

## Package a distributable

```bash
npm run electron:pack
```

Outputs `electron-release/ERPDataFinder-<platform>-<arch>/`.

## Build a Windows installer (.exe)

Use **electron-builder** to produce a real NSIS installer that users
download and double-click to install — with Start Menu / Desktop shortcuts
and an uninstaller registered in Windows.

### One-time setup

```bash
npm install --save-dev electron-builder
```

### Build the installer

On Windows (recommended):

```bash
npm run electron:build:win
```

Output: `electron-release/ERPDataFinder-Setup-1.0.0.exe`

That single `.exe` is the installer. Distribute it to users — they run it,
pick an install location, and get Start Menu + Desktop shortcuts plus an
entry in **Add or remove programs**.

### Optional: portable single-exe (no install)

```bash
npm run electron:build:win:portable
```

Produces a single `ERPDataFinder-Setup-1.0.0.exe` that runs without
installing — useful for USB / locked-down machines.

### Building Windows installer from macOS or Linux

electron-builder can cross-build, but needs **Wine** + **mono** on the
build machine to produce a Windows NSIS installer:

- macOS: `brew install wine-stable mono`
- Linux (Debian/Ubuntu): `sudo apt install wine mono-devel`

Then run `npm run electron:build:win` — output is the same `.exe`.

For a hands-off build, push the repo to GitHub and run electron-builder
inside a `windows-latest` GitHub Actions runner — no Wine needed.

### Code signing (optional but recommended)

Unsigned installers trigger a Windows SmartScreen warning ("Windows
protected your PC"). To sign:

1. Buy an **Authenticode code-signing certificate** (DigiCert, Sectigo, SSL.com).
2. Set env vars before building:
   ```bash
   set CSC_LINK=path\to\cert.pfx
   set CSC_KEY_PASSWORD=your-cert-password
   npm run electron:build:win
   ```

Without signing the app still installs and runs — users just click
"More info → Run anyway" the first time.

### What ships inside the installer

- The Electron runtime (Chromium + Node) bundled by electron-builder.
- The built React renderer (`dist/`).
- `electron/main.cjs`, `electron/preload.cjs`, `electron/searchEngine.cjs`.
- The `mssql` driver and its dependencies from `node_modules`.

`mssql` is a pure-JS driver — no native binaries, no extra setup on the
user's machine. They only need network access to the SQL Server.

## Architecture

- **Renderer (React)** — `src/components/erp/ErpApp.tsx` and friends. Talks
  to the main process via `window.erp` (exposed by `electron/preload.cjs`).
- **Main process** — `electron/main.cjs`. Owns the `mssql` connection pool,
  schema cache, search engine, and record fetch. Generic — no ERP-specific
  table names. Works against any SQL Server database.
- **Search engine** — issues per-table parametrized queries that OR all
  matching columns together with `TOP <remaining>` so it stops as soon as
  `maxResults` is reached. Uses `WITH (NOLOCK)` to avoid blocking and
  `TRY_CAST` for numeric / uniqueidentifier columns so bad casts don't
  abort the scan. Progress is streamed via `erp:searchProgress` IPC.
- **Schema cache** — populated on connect; reused for every search until
  disconnect.
- **Cancellation** — main process holds an `AbortController` per search;
  the Cancel button calls `erp:cancelSearch`.

## Extending

`electron/main.cjs` already includes a `getPrimaryKey` helper used by the
record viewer. Future modules (relationship explorer, dependency viewer,
migration helper) can register additional `ipcMain.handle` channels and
expose them through `preload.cjs`.