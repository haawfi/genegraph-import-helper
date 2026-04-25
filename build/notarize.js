/**
 * macOS notarization (DH1 §3).
 *
 * electron-builder's `afterSign` hook fires AFTER the code-signing
 * step finishes; this script then submits the freshly-signed `.app`
 * bundle to Apple's notarization service via `notarytool`. Apple
 * verifies the binary, staples a notarization ticket back into the
 * bundle, and the resulting `.dmg` / `.zip` is Gatekeeper-clean
 * (no "developer cannot be verified" warning on first launch).
 *
 * Auth uses an App Store Connect API key (preferred over an Apple
 * ID + app-specific password — more automatable, fewer credentials
 * to leak, no Apple ID 2FA prompts in CI). Three secrets:
 *
 *   APPLE_API_KEY_ID         — short identifier (e.g. "ABC123XYZ")
 *   APPLE_API_KEY_ISSUER_ID  — UUID for the issuer team
 *   APPLE_API_KEY            — path to the .p8 private key file
 *
 * In CI, the .p8 lives in a temp file written from a base64-encoded
 * GitHub Actions secret at workflow start; this script just reads
 * the path. Locally the developer can point `APPLE_API_KEY` at any
 * .p8 they have on disk.
 *
 * Skip behaviour:
 *
 *   1. Non-darwin host         — nothing to notarize. Return early.
 *   2. APPLE_API_KEY_ID unset  — dev build (no creds). Return early
 *                                with a clear log line so the
 *                                build's "ran without notarizing"
 *                                state is visible.
 *
 * The build still produces a working unsigned/un-notarized `.dmg`
 * locally; users hit a Gatekeeper warning on first launch and have
 * to right-click → Open. That's expected for dev. The DH1 release
 * pipeline (when secrets are present in GitHub Actions) is the
 * path that produces clean, notarized artifacts users can install
 * with one click.
 *
 * Refs:
 *   - https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution
 *   - https://github.com/electron/notarize
 */
const { notarize } = require("@electron/notarize")
const path = require("path")

exports.default = async function notarizing(context) {
  if (process.platform !== "darwin") return

  if (!process.env.APPLE_API_KEY_ID) {
    console.log(
      "[notarize] APPLE_API_KEY_ID not set — skipping (dev / unsigned build)",
    )
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  console.log(`[notarize] submitting ${appPath} to Apple notarytool…`)

  return await notarize({
    tool: "notarytool",
    appPath,
    appleApiKey: process.env.APPLE_API_KEY,
    appleApiKeyId: process.env.APPLE_API_KEY_ID,
    appleApiIssuer: process.env.APPLE_API_KEY_ISSUER_ID,
  })
}
