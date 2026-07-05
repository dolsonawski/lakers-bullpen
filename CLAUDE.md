# lakers-bullpen
Baseball analytics PWA for Minnewaska Lakers Baseball (ISD 2149).
Live at https://lakers-bullpen.web.app · Firebase project ID: lakers-bullpen (NEVER lakers-baseball).

## Stack
Vanilla JS, Firebase Hosting + Firestore, service worker offline.
Key files in public/: index.html, app.js, styles.css, sw.js, firebase-data-layer.js, player-stats.js, gamechanger-import.js.

## Design system
Palette: royal #104D97, green #028342, navy #092B49.
Pitch colors: FA #e84545, BB #3b82f6, CH #f59e0b.
Fonts: Bebas Neue, DM Sans, IBM Plex Mono.

## Invariants
- Game stats schema: players/{id}/statlines/{year_term_level}; bullpen: pitchers/{name}/sessions/{id}
- Pitch locations entered from the PITCHER'S view — never mirror columns
- Coach PIN 2149, client-side only, intentional
- Percentile tiers: Upper = Varsity+Legion; Lower = JV/Freshman/Jr Legion
- Qualifiers: 15 PA hitting, 5 IP pitching; term tags Sp/Su/Fa/Wi
- Data stays in context: availability on Board tab only; BP on Hitting; pop/sprint on Fielding

## Working preferences (Drew)
- Mockups before code on design decisions; present options, wait for a pick
- Surgical, file-referenced edits; no broad rewrites
- Pick reasonable defaults and state them — no unnecessary questions
- Push back honestly; never surface-agree

## Releasing
Follow .claude/skills/lakers-release/SKILL.md for every release: new version number,
bump sw.js cache (lakers-bullpen-vXX), Puppeteer verify at 1400px + 390px,
firebase deploy --only hosting (add ,firestore:rules if rules changed), then verify:
curl -s "https://lakers-bullpen.web.app/sw.js?cb=$(date +%s)" | grep CACHE
