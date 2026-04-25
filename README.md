# GeneGraph Import Helper

A small Electron app that brings Google Takeout archives — and other
large photo archives — into [GeneGraph](https://www.genegraph.eu).

The helper is an **import bridge**, not a background sync daemon.
See [`docs/strategy.md`](docs/strategy.md) for the positioning
rationale (storage economics, product framing, what the helper is
deliberately not).

## What it does

- Watches your Downloads folder for Google Takeout archives.
- Detects multi-part archives (`takeout-*.zip` / `.tgz`) and waits
  for every part before starting the upload.
- Asks the user to confirm before uploading anything (asymmetric
  buttons — approve is specific, decline is generic).
- Uploads in chunks with exponential-backoff retry on partial
  failure. Large archives (multi-GB) survive flaky connections.
- Stores its auth token in the OS keychain (Keychain on macOS,
  Credential Manager on Windows). No tokens on disk.

## What it deliberately does not do

- Background folder sync (every-photo-as-it-arrives style — like
  Dropbox / iCloud Photos).
- Folder watching beyond Takeout-style archives.
- OCR, face clustering, DNA analysis, or any AI inference.
- Direct API integrations with MyHeritage / Ancestry / FamilySearch.

These are deferred until clear demand signals or partnership
conversations make them worth building. See `docs/strategy.md`.

## Build

Requirements: Node 20+, npm. Tested with Electron 41.

```bash
npm ci
npm run build         # tsc → dist/
npm run dist          # electron-builder for current platform
npm run dist:mac      # macOS dmg + zip (arm64 + x64)
npm run dist:win      # Windows nsis + portable (x64)
```

Local builds are unsigned. Signed + notarized artifacts are produced
by GitHub Actions when the relevant secrets are present (see CI
section below).

## Development

```bash
npm ci
npm run dev           # tsc --watch + electron with hot main reload
```

The dev build talks to `process.env.GENEGRAPH_API_BASE` (defaults
to the production API). Override during local development against a
local Next.js server with:

```bash
GENEGRAPH_API_BASE=http://localhost:3000 npm run dev
```

## Releases

Releases are published from this repo as GitHub Releases. Tagging
`v*.*.*` on `main` triggers `.github/workflows/release.yml`, which
builds for macOS + Windows and publishes signed (when secrets
present) or unsigned (when absent) artifacts.

The historical alpha-2 release (tag `desktop-helper-v1.0.0-alpha.2`)
predates DH1 and uses the old "FamVault Desktop Helper" branding.
That release stays as a historical artifact; new releases use plain
`v*.*.*` tags and the "GeneGraph Import Helper" naming.

## Internal naming notes (DH1)

For backward compatibility with existing alpha-tester tokens and
settings, several internal identifiers retain "famvault" /
"desktop-helper" forms even after the user-facing rename:

- `appId: com.genegraph.famvault.desktop-helper` (changing it would
  invalidate auth tokens issued under the old appId).
- npm package `name: famvault-desktop-helper` (changing it
  invalidates npm cache; cosmetic-only otherwise).
- Keychain `SERVICE_NAME: "GeneGraph Desktop Helper"` in
  `src/auth-manager.ts` (alpha-tester tokens are stored under this
  service name; preserving it keeps existing testers signed in).
- Keychain access group entitlement in
  `build/entitlements.mac.plist` (matches the appId).

User-visible strings (productName, dmg/installer titles, tray
tooltip, notification titles) all say "GeneGraph Import Helper".
A future v2.0 reconciliation can tidy up the internal identifiers
if/when there's a reason to.

## Repository

`haawfi/genegraph-import-helper` — was renamed from
`haawfi/genegraph-desktop-releases` on 2026-04-25. GitHub
auto-redirects the old URL, so existing download links keep working.

## License

MIT.
