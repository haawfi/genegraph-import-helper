# Desktop Helper — sign + notarize runbook

End-to-end recipe for producing a Gatekeeper-clean macOS .dmg of the
GeneGraph Import Helper. This file is the source of truth for every
release; the GitHub Actions release workflow at
`.github/workflows/release.yml` follows the same pipeline with
secrets injected from Actions.

## Status (2026-05-02)

- **Apple Developer Program enrollment: in review** (Enrollment ID
  `5935H366TV`, team "AccuWealth Holding Oy" — the older legal name
  for AWFi Group Oy). Until Apple approves the enrollment, the
  certificate-management UI at developer.apple.com and App Store
  Connect access are both gated. Typical wait: 24–48 h after a
  successful payment + DUNS verification; some entities wait longer.
- The build pipeline (`electron-builder`, `build/notarize.js`
  afterSign hook, `build/entitlements.mac.plist`) is already wired.
  All that's missing is the cert + the API key.
- A Certificate Signing Request was pre-staged at
  `~/.genegraph/notarization/genegraph-helper.csr` so it's ready to
  upload the moment Apple approves. The matching private key is at
  `~/.genegraph/notarization/genegraph-helper.key` (mode `600`).

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

# Identity for codesign — replace TEAMID with the 10-char team id
export CSC_NAME="Developer ID Application: AWFi Group Oy (TEAMID)"
export CSC_KEYCHAIN=login.keychain-db

# notarytool credentials — paths + ids from Phase 5 above
export APPLE_API_KEY_ID="<KEYID>"
export APPLE_API_KEY_ISSUER_ID="<ISSUER_UUID>"
export APPLE_API_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8"

# Unlock the keychain so codesign can read the private key
# non-interactively. Skip if Keychain is already unlocked in this
# shell session.
security unlock-keychain login.keychain-db

# Build, sign, notarize, staple
npm run dist:mac

# Total wall time ≈ 10–40 min — the Apple notary service is the
# slow step. Watch the output for "notarization complete  status=Accepted"
# and "stapled".
```

The build pipeline (electron-builder + build/notarize.js afterSign)
reads `CSC_NAME` for codesign and the `APPLE_API_KEY*` vars for
notarytool. Both halves are required for a Gatekeeper-clean
artifact; missing either falls through to an unsigned dev build
(see `build/notarize.js` short-circuit logic).

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

- **Apple's record of legal entity is "AccuWealth Holding Oy"**,
  the older name. The active entity is **AWFi Group Oy** (Y
  3460768-7). Until Apple's record is updated, the Developer ID
  Application cert (and the publisher name shown to users in the
  Gatekeeper "verified developer" prompt) will read "AccuWealth
  Holding Oy". To update: contact Apple Developer Support with
  legal documentation of the name change. Cosmetic only —
  signing works either way.
- The `electron-builder` config has `mac.notarize: false` AND an
  `afterSign: "build/notarize.js"` hook. This is intentional —
  the hook handles notarization explicitly so the CI pipeline
  can short-circuit when secrets are absent (dev builds). Don't
  flip `mac.notarize` to `true` — that would double-notarize
  and break the build.
