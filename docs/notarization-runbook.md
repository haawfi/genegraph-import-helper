# Desktop Helper — sign + notarize runbook

End-to-end recipe for producing a Gatekeeper-clean macOS .dmg of the
GeneGraph Import Helper. This file is the source of truth for every
release; the GitHub Actions release workflow at
`.github/workflows/release.yml` follows the same pipeline with
secrets injected from Actions.

## Status (2026-05-02)

Pipeline is **live** under the founder's individual Apple Developer
account, not the AWFi Group Oy organization enrollment (which was
still in review when this work happened). The decision was to ship
the alpha now and revisit the org account later — the Gatekeeper
"verified developer" prompt currently reads "HAFIZ HASNAT AHMAD"
rather than the company name.

Live values:

| Thing | Value |
|---|---|
| Apple team | `HAFIZ HASNAT AHMAD` (individual) |
| Team ID | `U4ZFU569NH` |
| Cert SHA1 | `9D062275D7FDEF3A16CC46DDB5F4FD3944AAF646` |
| Cert expiry | 2031-05-03 (5 years) |
| ASC API Key ID | `ASUXRXSDPJ` |
| ASC API Issuer ID | `6296ec18-f35e-4bf3-9cbd-42f35bd24eb0` |
| ASC API key file | `~/.appstoreconnect/private_keys/AuthKey_ASUXRXSDPJ.p8` |

The build pipeline (`electron-builder`, `build/notarize.js`
afterSign hook, `build/entitlements.mac.plist`) was already wired
from DH1. The .p12 (cert + private key bundle) lives at
`~/.genegraph/notarization/developerID_application.p12`; the export
password is in 1Password / the founder's password store (not on
disk).

---

## One-time setup

Do this once when the Apple Developer Program enrollment is active,
or whenever the Developer ID Application certificate expires (every
5 years).

### 1. Verify membership is active

Visit <https://developer.apple.com/account>. The landing page should
show **"Certificates, Identifiers & Profiles"**, not "Your enrollment
is being processed."

If still in review: stop. There is no expedite path — wait for
Apple. The enrollment review lives entirely on Apple's side.

### 2. Reuse or create a Certificate Signing Request

A CSR is pre-staged at `~/.genegraph/notarization/`. To regenerate
(e.g., after rotating keys):

```bash
mkdir -p ~/.genegraph/notarization
cd ~/.genegraph/notarization
openssl req -new -newkey rsa:2048 -nodes \
  -out genegraph-helper.csr \
  -keyout genegraph-helper.key \
  -subj "/emailAddress=ha@aw-fi.com/CN=AWFi Group Oy/C=FI"
chmod 600 genegraph-helper.key
```

`genegraph-helper.csr` is the public part — uploaded to Apple.
`genegraph-helper.key` is the private part — never commit, never
share. The 600 perms keep it from being readable by other users on
the same Mac.

### 3. Create the Developer ID Application certificate

1. Browse to <https://developer.apple.com/account/resources/certificates/list>.
2. Click **+** → **Developer ID Application** → Continue.
3. Upload `~/.genegraph/notarization/genegraph-helper.csr`.
4. Apple generates the cert. Click **Download** — saves a
   `developerID_application.cer` (or similar) file.
5. Move the `.cer` next to the CSR:

   ```bash
   mv ~/Downloads/developerID_application.cer ~/.genegraph/notarization/
   ```

### 4. Import the cert into the login Keychain

```bash
cd ~/.genegraph/notarization

# Convert .cer (DER) → .pem (PEM) so OpenSSL can pair it with the key
openssl x509 -in developerID_application.cer -inform DER -out developerID_application.pem -outform PEM

# Bundle .pem (public) + .key (private) into a .p12 for Keychain import
openssl pkcs12 -export \
  -out developerID_application.p12 \
  -inkey genegraph-helper.key \
  -in developerID_application.pem \
  -name "Developer ID Application: AWFi Group Oy"
# Set a strong export password when prompted; record it somewhere
# safe (1Password / sealed envelope). Needed again to re-import on
# another machine OR for CI base64 encoding.

# Import into login.keychain-db, allowing codesign to use it
security import developerID_application.p12 \
  -k ~/Library/Keychains/login.keychain-db \
  -P "<the export password>" \
  -T /usr/bin/codesign

# Verify the new identity is listed
security find-identity -v -p codesigning
```

The output should include something like:

```
1) <SHA-1> "Developer ID Application: AWFi Group Oy (TEAMID)"
```

Note the full identity string + the 10-character TEAMID — both go
into the build env later.

### 5. Generate an App Store Connect API key for notarytool

`notarytool` authenticates to Apple's notary service with an API
key (newer + headless; preferred over Apple-ID + app-specific
password).

1. Browse to <https://appstoreconnect.apple.com/access/integrations/api>.
2. **Team Keys** tab → **+** → name it `GeneGraph Helper Notarization`,
   role `Developer`.
3. Click **Generate**. Apple shows the new key with a one-time
   download button — Apple will never let you download it again.
4. Save the `.p8` to:

   ```bash
   mkdir -p ~/.appstoreconnect/private_keys
   mv ~/Downloads/AuthKey_*.p8 ~/.appstoreconnect/private_keys/
   ```

5. Note the **Key ID** (10-char alphanumeric) and **Issuer ID**
   (UUID) from the page.

### 6. (Optional) Store the notarytool credential profile

If you prefer a keychain-backed profile over passing env vars on
every build:

```bash
xcrun notarytool store-credentials "GeneGraph-Helper-Notary" \
  --key ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8 \
  --key-id <KEYID> \
  --issuer <ISSUER_UUID>
```

Then any later notarytool call can use `--keychain-profile
"GeneGraph-Helper-Notary"`. Note: the `build/notarize.js` afterSign
hook reads env vars directly (matches the CI shape), so the
keychain profile isn't strictly required.

---

## Per-build

Once the one-time setup is done, every release looks like:

```bash
cd ~/Desktop/GeneGraph/desktop-helper

# Identity for codesign.
#
# CRITICAL: electron-builder 26.x rejects the "Developer ID
# Application:" prefix and tells you to remove it. Use the SHA1
# instead — unambiguous + survives any common-name change Apple
# might do later.
#
# Get the SHA1 from: security find-identity -v -p codesigning
# (the 40-char hex prefix on the Developer ID Application line)
export CSC_NAME="9D062275D7FDEF3A16CC46DDB5F4FD3944AAF646"
export CSC_KEYCHAIN=login.keychain-db

# notarytool credentials — paths + ids from Phase 5 above
export APPLE_API_KEY_ID="ASUXRXSDPJ"
export APPLE_API_KEY_ISSUER_ID="6296ec18-f35e-4bf3-9cbd-42f35bd24eb0"
export APPLE_API_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_ASUXRXSDPJ.p8"

# Unlock the keychain so codesign can read the private key
# non-interactively. Triggers a macOS GUI prompt for the login
# password the first time per session.
security unlock-keychain ~/Library/Keychains/login.keychain-db

# Build, sign, notarize, staple
npm run dist:mac

# Total wall time ≈ 10–40 min — the Apple notary service is the
# slow step. Watch the output for "notarization complete  status=Accepted"
# and "stapled".
```

The build pipeline (electron-builder + `build/notarize.js`
afterSign + `build/notarize-dmg.js` afterAllArtifactBuild) reads
`CSC_NAME` for codesign and the `APPLE_API_KEY*` vars for
notarytool. The afterSign hook notarizes + staples the **.app
bundle**; the afterAllArtifactBuild hook notarizes + staples each
**.dmg** afterwards (electron-builder builds the DMG after the
afterSign hook runs, so the DMG won't have a ticket without this
second pass). Both halves are required for a fully Gatekeeper-clean
artifact that works offline; missing the env vars short-circuits
to an unsigned dev build.

### Verifying the artifact

```bash
# Replace with the actual filename from dist/
APP="dist/mac/GeneGraph Import Helper.app"
DMG="dist/GeneGraph Import Helper-1.0.0-alpha.2.dmg"

# 1. Codesign accepts it
codesign --verify --deep --strict --verbose=2 "$APP"
# Expected: "...valid on disk" + "...satisfies its Designated Requirement"

# 2. Gatekeeper accepts it
spctl --assess --type execute --verbose=4 "$APP"
# Expected: "...accepted ... source=Notarized Developer ID"

# 3. Staple is attached
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"
# Expected: "The validate action worked!"

# 4. Smoke test — open the DMG on a Mac that has never run the
#    unsigned version. (Macs that have run an earlier unsigned
#    copy may have a cached negative verdict; clear with
#    xattr -d com.apple.quarantine /path/to/installed.app)
```

---

## Distribution

After a clean notarized + stapled build lands in `dist/`, ship it
to users through GitHub Releases on this repo
(`haawfi/genegraph-import-helper`). The web app reads the asset URL
from a Vercel env var, so the upload + env-var update are paired.

```bash
cd ~/Desktop/GeneGraph/desktop-helper
REPO=haawfi/genegraph-import-helper
TAG=desktop-helper-vX.Y.Z   # match the package.json version

# 1. Upload both DMGs to the existing release tag (or create a new
#    one — first push the tag with `git tag $TAG <SHA> && git push
#    origin $TAG`, then `gh release create $TAG ...`).
#
#    Replacing assets on an existing tag is fine — `--clobber` lets
#    you overwrite, and the URL stays stable. Drop the OLD unsigned
#    asset first to avoid two competing macOS files on the release.
gh release delete-asset "$TAG" "<old-mac-asset-name>.dmg" --repo "$REPO" --yes || true
gh release upload "$TAG" \
  "dist/GeneGraph Import Helper-X.Y.Z-arm64.dmg" \
  "dist/GeneGraph Import Helper-X.Y.Z.dmg" \
  --repo "$REPO" --clobber

# 2. GitHub auto-sanitizes spaces in filenames to "." in URLs:
#    "GeneGraph Import Helper-X.Y.Z-arm64.dmg"
#      → "GeneGraph.Import.Helper-X.Y.Z-arm64.dmg"
#    Capture the canonical asset URLs (the env-var must point at
#    the period-form, not %20):
ARM64_URL="https://github.com/haawfi/genegraph-desktop-releases/releases/download/$TAG/GeneGraph.Import.Helper-X.Y.Z-arm64.dmg"

# 3. Update the Vercel env vars on the web project.
#
#    DO NOT use `vercel env add` from CLI 52.x — it has a regression
#    where new vars default to `type: "sensitive"` and pipe/heredoc
#    input lands as empty. Use the API directly:
TOKEN=$(jq -r .token ~/Library/Application\ Support/com.vercel.cli/auth.json)
PROJECT_ID=prj_2xWGH6hkDnULHq7F4hkFC2W7zR9w
ORG_ID=team_xOM7786toQZdYZ68l1Jc8LgD
# DELETE the old vars first (safer than PATCH, which silently fails
# on sensitive-typed entries):
for ID in <NEXT_PUBLIC_DESKTOP_HELPER_URL_ID> <NEXT_PUBLIC_DESKTOP_HELPER_URL_MAC_ID>; do
  curl -X DELETE -H "Authorization: Bearer $TOKEN" \
    "https://api.vercel.com/v9/projects/$PROJECT_ID/env/$ID?teamId=$ORG_ID"
done
# POST fresh entries with type=plain (non-sensitive — required for
# `vercel env pull` to be able to read them back during local dev):
for KEY in NEXT_PUBLIC_DESKTOP_HELPER_URL NEXT_PUBLIC_DESKTOP_HELPER_URL_MAC; do
  curl -X POST -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg k "$KEY" --arg v "$ARM64_URL" \
      '{key:$k, value:$v, type:"plain", target:["production"]}')" \
    "https://api.vercel.com/v10/projects/$PROJECT_ID/env?teamId=$ORG_ID"
done

# 4. Trigger a Vercel rebuild. NEXT_PUBLIC_* values are inlined at
#    build time — env-var changes alone don't update the live page;
#    a fresh build is required. Easiest path: push any commit to
#    main (e.g. a copy fix on the download page); a no-op rebuild
#    via the dashboard works too.

# 5. Verify end-to-end: download from https://www.genegraph.eu/dashboard/download
#    on a Mac that has never seen the unsigned version. The .app
#    should open without the "developer cannot be verified"
#    Gatekeeper warning. If it persists, clear the cached verdict:
#    xattr -d com.apple.quarantine /Applications/GeneGraph\ Import\ Helper.app
```

The arm64 build is the primary download (~80%+ of new Macs since
2020). The x64 build also lives on the release for users who find
it via "Browse all releases" — keeps Intel users covered without
adding a second download button on the page.

---

## Cert renewal

Developer ID Application certs are valid for **5 years**.

When yours is approaching expiry:

1. Generate a new CSR (Section 2 above) — different filename to
   keep the old one available during overlap.
2. Upload the new CSR to Apple, download the new `.cer`.
3. Repeat Section 4 (import into Keychain). The old identity stays
   in the Keychain until it expires; the build picks the
   non-expired one via `CSC_NAME`.
4. Update `CSC_NAME` if the team id changed (it shouldn't unless
   the legal entity name changes).

The `.p8` API key never expires unless revoked.

---

## CI / GitHub Actions

`.github/workflows/release.yml` does the same pipeline on
`macos-latest` runners. It expects these secrets, set in the repo's
**Settings → Secrets and variables → Actions**:

| Secret | What it is |
|---|---|
| `MAC_CSC_LINK` | base64 of the `.p12` (one-time setup output) |
| `MAC_CSC_KEY_PASSWORD` | the `.p12` export password from Phase 4 |
| `APPLE_API_KEY_ID` | the 10-char key id |
| `APPLE_API_KEY_ISSUER_ID` | the UUID issuer id |
| `APPLE_API_KEY` | base64 of the `.p8` (decoded to a tempfile at runtime) |

To populate them:

```bash
# .p12 → base64 → MAC_CSC_LINK
base64 -i ~/.genegraph/notarization/developerID_application.p12 | pbcopy

# .p8 → base64 → APPLE_API_KEY
base64 -i ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8 | pbcopy
```

Paste each into the corresponding secret in GitHub. Never commit
the `.p12` / `.p8` / password to the repo.

---

## Troubleshooting

### `errSecInternalComponent` from codesign

Keychain locked OR cert not accessible to `codesign`. Fix:

```bash
security unlock-keychain login.keychain-db
# Re-run the build
```

If it persists, the cert may not be granting `codesign` access.
Re-import with `-T /usr/bin/codesign`:

```bash
security import developerID_application.p12 \
  -k ~/Library/Keychains/login.keychain-db \
  -P "<password>" \
  -T /usr/bin/codesign
```

### `Status: Invalid` from notarytool

Apple rejected the submission. Pull the log:

```bash
xcrun notarytool log <submission-id> \
  --keychain-profile "GeneGraph-Helper-Notary"
```

Most common causes:
- Missing entitlements (especially the JIT pair on Electron apps)
- `hardenedRuntime: false` — must be `true` for notarization
- An unsigned binary inside the `.app` bundle (some npm
  postinstall scripts ship unsigned `.dylib`s; `electron-builder`
  signs them but only if the cert is found)

### Gatekeeper warning still appears after install

The build is correct; the test machine has a cached negative
verdict from running the unsigned version earlier. Either:

```bash
xattr -d com.apple.quarantine /Applications/GeneGraph\ Import\ Helper.app
```

…or test on a machine that has never seen the unsigned version.

---

## Related files

- `package.json` `build` block — electron-builder config, identity
  + entitlements + targets
- `build/entitlements.mac.plist` — entitlements granted to the
  signed binary (JIT, network.client, keychain-access, file
  access)
- `build/notarize.js` — afterSign hook that submits the freshly
  signed `.app` to Apple's notary service
- `.github/workflows/release.yml` — CI mirror of the per-build
  flow
- `~/.genegraph/notarization/` — sensitive credential files
  (CSR, key, .cer, .p12). NEVER commit.
- `~/.appstoreconnect/private_keys/AuthKey_*.p8` — App Store
  Connect API key. NEVER commit.

---

## Discoveries worth surfacing

- **Currently signed under the founder's individual account**
  (HAFIZ HASNAT AHMAD / U4ZFU569NH), not the AWFi Group Oy
  organization. The Gatekeeper "verified developer" prompt reads
  the founder's name. To switch later: re-do Sections 3–5 against
  the org account once that enrollment is approved (CSR is
  reusable; only the cert + .p12 + ASC API key change). The
  unrelated org enrollment (ID `5935H366TV`, team filed under the
  older "AccuWealth Holding Oy" name) was still under review at
  ship time — typical wait 24–48 h after DUNS, sometimes longer.
- The `electron-builder` config has `mac.notarize: false` AND an
  `afterSign: "build/notarize.js"` hook. This is intentional —
  the hook handles notarization explicitly so the CI pipeline
  can short-circuit when secrets are absent (dev builds). Don't
  flip `mac.notarize` to `true` — that would double-notarize
  and break the build.
- **electron-builder 26.x rejects `CSC_NAME="Developer ID
  Application: ..."` with "remove the prefix"** — use either the
  bare common name or (preferred) the SHA1 of the identity. The
  per-build snippet above uses SHA1 for that reason.
