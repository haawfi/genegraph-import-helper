/**
 * macOS DMG notarization (DH3 — fills the gap left by build/notarize.js).
 *
 * The afterSign hook (build/notarize.js) submits the freshly-signed .app
 * bundle to Apple. But electron-builder builds the .dmg AFTER afterSign
 * fires, so the .dmg itself never gets a notarization ticket and
 * `xcrun stapler staple <dmg>` fails with "Record not found." The .app
 * inside is fine, but a non-stapled DMG means Gatekeeper has to do an
 * online check — which fails offline or behind firewalls and triggers
 * a "developer cannot be verified" prompt.
 *
 * This hook runs as `afterAllArtifactBuild` (after every artifact is on
 * disk), filters for .dmg files, submits each to notarytool, waits for
 * Accepted, and staples the ticket. Result: every shipped .dmg is
 * Gatekeeper-clean offline.
 *
 * Skip behaviour matches build/notarize.js — if the env vars aren't
 * set (dev build), return early with a clear log line.
 */
const { execFileSync } = require("child_process")

exports.default = async function notarizeDmg(buildResult) {
  if (process.platform !== "darwin") return

  if (!process.env.APPLE_API_KEY_ID) {
    console.log(
      "[notarize-dmg] APPLE_API_KEY_ID not set — skipping (dev build)",
    )
    return
  }

  const dmgs = (buildResult.artifactPaths || []).filter((p) =>
    p.endsWith(".dmg"),
  )
  if (dmgs.length === 0) return

  for (const dmg of dmgs) {
    console.log(`[notarize-dmg] submitting ${dmg}`)
    execFileSync(
      "xcrun",
      [
        "notarytool",
        "submit",
        dmg,
        "--key",
        process.env.APPLE_API_KEY,
        "--key-id",
        process.env.APPLE_API_KEY_ID,
        "--issuer",
        process.env.APPLE_API_KEY_ISSUER_ID,
        "--wait",
      ],
      { stdio: "inherit" },
    )
    console.log(`[notarize-dmg] stapling ${dmg}`)
    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" })
  }
}
