---
name: lakers-release
description: Release checklist and deploy workflow for the lakers-bullpen Firebase PWA (lakers-bullpen.web.app). Use this skill EVERY time a change to the lakers-bullpen app is ready to ship — whenever the user asks to package a zip, cut a new version, deploy, release, push to Firebase, or says "ship it" or "build vXX". Also use it when a deploy fails or the live site shows a stale version, to diagnose against the known failure modes. Never package or deploy lakers-bullpen without following this checklist.
---

# Lakers Bullpen Release Skill

Release workflow for the `lakers-bullpen` Firebase PWA. The project is always named
**`lakers-bullpen`** — never `lakers-baseball` (a stale legacy ID that has caused
failed deploys). Hosting URL: `https://lakers-bullpen.web.app`. Firebase project ID:
`lakers-bullpen`.

Two release modes exist. Prefer **git mode** when the repo is available (Claude Code /
GitHub). Use **zip mode** only when working from an uploaded zip in claude.ai chat.

---

## Pre-release checklist (both modes)

Complete ALL of these before packaging or deploying. Do not skip any step.

1. **Pick a new version number.** Increment from the last shipped version. NEVER
   reuse a version number or filename — Cloud Shell retains old zips and a
   same-named file silently deploys stale code. If a release fails for any reason,
   the fix ships under the NEXT number, not a "corrected" copy of the same one.

2. **Bump the service worker cache.** In `public/sw.js`, the cache constant follows
   the pattern `lakers-bullpen-vXX` and MUST match the release number. If the cache
   version is not bumped, clients will keep serving the old app shell and the
   deploy will look like it "didn't work."

3. **Syntax-check every edited file.** `node --check` for JS; for HTML/CSS, load in
   the verification harness (step 4).

4. **Run headless verification before packaging.** Use the Puppeteer harness with
   the mock Firebase data layer (seeded with realistic player data). Assert at two
   viewports: desktop **1400px** and mobile **390px**. Verify at minimum:
   - App boots with no console errors
   - The changed feature renders and behaves as intended
   - No view bleeds into other views (regression check for the `.view-board`
     class of bug: every `.view-*` container needs a `display:none` default and
     an `.active` rule)
   - If the repo contains `verify/` or `test/` harness files, run those; do not
     regenerate a harness from scratch if one exists.

5. **Firestore rules check.** If `firestore.rules` changed this release, the deploy
   command must include `firestore:rules` (see deploy commands below). A
   hosting-only deploy after a rules change causes silent empty reads.

6. **Known invariants — verify none were violated:**
   - Pitch location data is entered from the **pitcher's view** (never mirror columns)
   - Coach write PIN is `2149`, client-side only, intentional — do not "fix" it
   - Firestore schema for game stats: `players/{id}/statlines/{year_term_level}`
   - Data stays in context: availability only on Board tab, BP data on Hitting tab,
     pop/sprint on Fielding tab
   - Unified pitch colors: FA `#e84545`, BB `#3b82f6`, CH `#f59e0b`
   - District palette: royal `#104D97`, green `#028342`, navy `#092B49`
   - Fonts: Bebas Neue, DM Sans, IBM Plex Mono

---

## Git mode (preferred — Claude Code / repo checkout)

1. Complete the pre-release checklist above.
2. Commit with a message of the form `vXX: <summary of changes>`.
3. Deploy from the repo root:
   ```bash
   firebase use lakers-bullpen
   firebase deploy --only hosting          # code-only release
   firebase deploy --only hosting,firestore:rules   # if rules changed
   ```
4. Verify (see Verification below).
5. Push to GitHub so the repo stays the source of truth:
   ```bash
   git push
   ```

No zip is created in git mode.

## Zip mode (legacy — claude.ai chat + Cloud Shell)

1. Complete the pre-release checklist above.
2. **Package with the wrapper folder.** The archive MUST contain a single top-level
   `lakers-bullpen/` directory wrapping all contents (matching v29 structure):
   ```bash
   cd /home/claude && zip -r lakers-bullpen-firebase_vXX.zip lakers-bullpen/
   ```
3. **Verify the archive structure before delivering** — this failure shipped twice
   in v30:
   ```bash
   unzip -l lakers-bullpen-firebase_vXX.zip | head -20
   ```
   Every path must begin with `lakers-bullpen/`. If any file sits at archive root,
   repackage. Also confirm `lakers-bullpen/public/` contains `index.html`, `app.js`,
   `styles.css`, `sw.js`, `firebase-data-layer.js`.
4. Deliver the zip with these exact Cloud Shell commands (fill in vXX):
   ```bash
   rm -rf ~/lakers-bullpen && unzip -o ~/lakers-bullpen-firebase_vXX.zip -d ~
   ls ~/lakers-bullpen/public        # sanity: ~11 files incl. app.js, styles.css
   cd ~/lakers-bullpen && firebase use lakers-bullpen && firebase deploy --only hosting
   ```
   Append `,firestore:rules` to the deploy if rules changed. The `rm -rf` is
   mandatory — stale extracted files are a proven cause of deploying old code.

## Verification (both modes — never skip)

Confirm the live cache version matches the release:

```bash
curl -s "https://lakers-bullpen.web.app/sw.js?cb=$(date +%s)" | grep CACHE
```

Expected output contains `lakers-bullpen-vXX` for the version just shipped. If it
shows the previous version: hosting deploy did not complete, or was run from the
wrong directory (must be `cd ~/lakers-bullpen` first), or a stale zip was extracted.

On-device: clients auto-reload via the `controllerchange` listener once the new SW
takes control; a force-refresh may still be needed on iOS standalone installs.

## Failure diagnosis quick table

| Symptom | Likely cause | Fix |
|---|---|---|
| `cd ~/lakers-bullpen: No such file` | Zip missing top-level wrapper folder | Repackage per zip mode step 2; bump to NEW version number |
| Deploy "succeeds" but curl shows old version | Stale same-named zip or missing `rm -rf` | New filename + full `rm -rf` sequence |
| Deploy fails on project | Wrong project ID (`lakers-baseball`) | `firebase use lakers-bullpen` |
| App loads but data empty after release | Rules changed without `firestore:rules` deploy | Redeploy with `--only hosting,firestore:rules` |
| Live site looks unchanged on device | SW cache not bumped in `sw.js` | Bump cache constant, redeploy as next version |
