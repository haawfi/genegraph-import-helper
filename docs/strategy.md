# GeneGraph Import Helper — strategy

**Status:** v1 launch positioning. Locked in DH1 (2026-04-25).
Revisit only on a strong demand signal that contradicts one of the
deferrals below.

This is the one-page positioning document for the Import Helper.
It exists so the framing is portable across sessions, contributors,
and future contractors — without having to re-derive the reasoning
from a verbal handoff.

## What the helper IS

An **import bridge** for getting *large, one-shot photo and document
archives* into GeneGraph reliably. The shape that works today:

- User exports their data from a third-party platform (most often
  Google Takeout — multi-gigabyte, multi-part `.zip` / `.tgz`
  archives).
- Helper detects the archive landing in the Downloads folder, waits
  for all parts to finish downloading, asks the user to confirm,
  then uploads in chunks to the GeneGraph API with
  exponential-backoff retry on partial failure.
- Auth tokens live in the OS keychain. The browser-based OTP flow
  is the only sign-in path today; eID is deferred (see below).
- The app sits in the system tray, runs quietly, and notifies the
  user on detection / progress / completion / errors.

The helper exists because **this specific moment — moving years of
photos out of Google and into your own family vault — is a
high-value, high-friction operation that deserves a native
experience.** Drag-and-drop a 200 GB Takeout into a browser tab
doesn't work. The helper turns "I have 200 GB of family photos
trapped at Google" into a one-click upload that survives network
interruptions.

## What the helper is NOT

A background folder-sync daemon. Not now, not in v1.0, not in v1.x.

That distinction is load-bearing — it's the reason this codebase
stays small and shippable instead of bloating into a Dropbox
competitor that we'd then have to staff and operate. Concretely,
the helper does not:

- Watch arbitrary user folders for changes and sync new files
  automatically (Dropbox / iCloud Photos / Google Drive shape).
- Run OCR, face clustering, DNA-relative inference, or any AI
  pipeline locally.
- Provide direct API integrations with MyHeritage, Ancestry, or
  FamilySearch.
- Offer any feature beyond "watch for Takeout-style archives,
  confirm with user, upload."

## Why not a sync daemon — the economic argument

The pricing model GeneGraph ships at v1.0 anchors every tier to a
**20% COGS ceiling** (cost of goods sold ≤ 20% of subscription
revenue). The two paid tiers as of 2026-04 are:

| Tier        | Price            | Storage          |
| ----------- | ---------------- | ---------------- |
| Premium     | €14.99 / month   | 15 GB            |
| Power User  | €49.99 / month   | 50–75 GB         |

A sync daemon changes the storage curve fundamentally. Every photo
the user takes on their phone, every document they download, every
file that hits a watched folder gets pushed. Real-world iCloud
Photos / Google Photos users sit between **0.5–2 TB** of media
across multiple devices. At Cloudinary's `raw` storage rates
(~$0.10/GB-month all-in including bandwidth), 1 TB = $100/month
COGS — which destroys the 20% ceiling on a €49.99 tier and makes
the Premium tier mathematically impossible.

Solving that problem requires either (a) a much higher price point
(€200+/month), (b) deduplication and selective-sync infrastructure
that's a multi-engineer-quarter build, or (c) negotiating a
cloud-storage deal with margins normally reserved for Dropbox-scale
operators. None of the three is a fight to pick at v1.0 launch.

The import-bridge model dodges this entirely. A user uploads their
Takeout archive once, decides what to keep in their vault, and the
storage curve flattens. Cap is set by the tier they're on, not by
ambient device-photo growth.

## Why not OCR / face / DNA / local inference

Same scope discipline. Each of these is a multi-quarter build:

- **OCR** — accurate-enough document OCR requires either a paid
  API (Cloudinary's add-on, Google Cloud Vision, AWS Textract —
  per-page or per-character pricing that scales with usage) or a
  bundled local model (~hundreds of MB binary bloat, plus quality
  drift across language, script, and document layout).
- **Face clustering** — works fine with Google Photos quality
  models locally, but the privacy story for "we scan every face in
  your photos" is non-trivial and the consent UX is its own
  multi-screen build.
- **DNA matching** — requires a partner who'll sell us API access
  to a real DNA database (23andMe, Ancestry, MyHeritage). All
  three of those companies are competitors at the platform level;
  partnership negotiations are an investor-funded conversation,
  not a v1.0 feature.

Each of these has a clear "ship when X" deferral signal and no
sooner. Building speculatively without the signal is what makes
genealogy software bloat into the unmaintainable forms that already
populate the market.

## Explicit deferrals

| Feature                                  | Deferred until                                                    |
| ---------------------------------------- | ----------------------------------------------------------------- |
| eID auth (Signicat / NemID / etc.)       | Investor or grant funding lands. Per-auth fee is the blocker — Signicat's per-month minimums + per-auth costs only make sense once we have committed user volume |
| OCR                                      | Demand signal in support tickets — "I can't search my documents" comes up often enough that it's the next obvious fix |
| Face clustering                          | Same — demand signal, plus a privacy-UX design pass that doesn't read as creepy |
| DNA matching                             | Partnership conversation with a willing DNA platform. Cold outreach without warm intro hasn't worked; investors who can warm-intro are the unlock |
| MyHeritage / Ancestry / FamilySearch APIs| Same — partnership conversations, not unilateral integration work |
| Background folder sync                   | Tier pricing redesign + storage-cost math review. Not v1.x         |

## What this means for the helper's commit history

DH1 lands the production-readiness chassis: signing, notarization,
auto-update, CI, naming, repo layout, download surface. DH2 lands
reliability hardening: SHA-256 archive dedup, persisted upload
state for crash recovery, OS sleep/wake handling, error
classification, confirmation modal variants, tray-menu surfacing
of resumable uploads. Beyond DH2, the helper should not grow new
feature surface — it grows in robustness and
breadth-of-archives-supported (adding iCloud archive layout,
OneDrive Personal Vault export formats, etc.) but stays an
import bridge.

## Reliability invariants (DH2)

After DH2, the helper holds the following four guarantees:

1. **Resume actually works.** `chunked-uploader.ts` queries
   `GET /api/import/desktop/upload/chunk?sessionId=X` before
   every upload to learn which chunks the server already has.
   Pre-DH2 that endpoint didn't exist; the helper's resume
   path silently fell through to "start from zero" every time.
   Now: re-uploaded bytes are zero unless the server lost data.

2. **Crashing the helper mid-upload doesn't lose state.** Active
   uploads are persisted to
   `<userData>/upload-state.json` via atomic tmp-file + rename
   on every confirmed chunk. On next launch the
   `startup-reconciler.ts` queries the server's canonical state
   for each entry and surfaces a Resume affordance via the tray
   menu (`buildActiveUploadsMenuItems` in `main.ts`). No auto-
   resume — the user clicked away from the upload originally,
   they may have done so deliberately.

3. **Re-detecting an already-uploaded archive is honest.** The
   helper computes a streaming SHA-256 of every archive before
   the modal opens and rides it as `archiveSha256` in the
   session-create POST. The server short-circuits with one of:
     - `{ deduplicated: true }` for a COMPLETED match → modal
       variant shows "already uploaded on [date]" with Skip
       (default) and Upload again (override).
     - `{ resuming: true, session }` for a non-terminal match
       → helper resumes that session id rather than creating
       a new one.

4. **OS sleeps don't cause spurious upload failures.**
   `powerMonitor.suspend` flushes the upload-state store;
   `powerMonitor.resume` arms the wake-clock for a 30-second
   tolerance window. Failures inside that window don't count
   against the chunked-uploader's 3-attempt retry budget — they
   log + retry without advancing the counter. Outside the
   window, normal retry policy applies (so a server that's
   genuinely down doesn't get unbounded retries).

5. **(Bonus invariant)** Error classification distinguishes
   401 / 410 / 413 / 422 / 5xx / network failure. Auth-fail
   pops the login window; permanent-fail surfaces a specific
   message and stops retrying; transient/retry runs the
   existing exponential-backoff path. Pre-DH2 every error got
   the same three-attempt treatment regardless of category.

The complete DH2 commit series is on `haawfi/genegraph` (server
side) and `haawfi/genegraph-import-helper` (helper side); see
`prompt-DH2-desktop-helper-reliability.md` for the full spec.

When a feature request arrives that doesn't fit the import-bridge
shape, default to "no, that's a future product expansion that
needs a separate build, separate funding, or both." The Helper's
small, shippable, signed, auto-updating bridge is what unlocks
v1.0 launch. Keeping it that way is what keeps v1.0 launchable.

## References

- `project_pricing_model.md` — the 20% COGS framing.
- `project_desktop_helper_strategy.md` — verbal-decision summary
  (codified here as DH1 §0 add-on).
- `prompt-DH1-desktop-helper-production-readiness.md` — the spec
  this codebase shipped under.
