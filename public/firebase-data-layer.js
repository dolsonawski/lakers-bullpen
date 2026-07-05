/* ============================================================
   LAKERS BULLPEN — FIREBASE DATA LAYER (season-aware)
   ------------------------------------------------------------
   Drop-in replacement for the old Google Apps Script backend.
   The app's existing code calls gasJsonp(url, params) with an
   `action` parameter; this file intercepts every action and
   serves it from Firestore instead. No other app code changes.

   Actions handled:
     check_tab      → does pitcher doc exist this season?
     create_tab     → create pitcher doc
     export         → write a session + recompute summary
     fetch_all      → leaderboard (per-season summary docs)
     fetch_player   → all pitch rows for one pitcher
     fetch_videos   → video library for the season
     fetch_location → tagged pitch zones for one pitcher

   Firestore layout:
     config/app                                   {currentSeason, seasons[]}
     seasons/{year}                               {year, roster[]}
     seasons/{year}/pitchers/{id}                 summary doc
     seasons/{year}/pitchers/{id}/sessions/{auto} one exported session
     seasons/{year}/videos/{id}                   {name, videos[{date,url}]}
   ============================================================ */

(function () {
  'use strict';

  /* ── 1. FIREBASE INIT ──────────────────────────────────────
     When hosted on Firebase Hosting, /__/firebase/init.js
     (loaded in index.html) auto-configures the SDK — nothing
     to paste. The manual config below is only a fallback for
     local testing; fill it in from Firebase Console →
     Project Settings → Your apps if you ever need it.        */
  var MANUAL_CONFIG = {
    // apiKey: "PASTE_ONLY_IF_TESTING_LOCALLY",
    // authDomain: "lakers-bullpen.firebaseapp.com",
    // projectId: "lakers-bullpen",
  };

  var db = null;
  var initError = null;

  function initFirebase() {
    try {
      if (typeof firebase === 'undefined') {
        throw new Error('Firebase SDK failed to load — check your internet connection');
      }
      if (!firebase.apps.length) {
        if (!MANUAL_CONFIG.projectId) {
          throw new Error('Firebase is not configured. Deployed on Firebase Hosting this is automatic; for local testing paste your config into firebase-data-layer.js');
        }
        firebase.initializeApp(MANUAL_CONFIG);
      }
      db = firebase.firestore();
      // Mobile networks (cellular, school guest wifi, captive portals, carrier
      // proxies) often block Firestore's default streaming transport, so the SDK
      // sits through a long timeout before falling back to long-polling — that's
      // the "load it once or twice before it's quick" stall on phones. Auto-detect
      // switches transports the instant the stream is blocked, with no penalty on
      // desktop wifi where streaming works first try. Must be set before any read
      // or persistence call, or the SDK throws.
      try { db.settings({ experimentalAutoDetectLongPolling: true }); } catch (e) {}
      enableOffline();
    } catch (e) {
      initError = e;
    }
  }
  initFirebase();

  /* ── 2. SEASON STATE ─────────────────────────────────────── */
  var CURRENT_SEASON = null;   // the season exports write to (from config/app)
  var SELECTED_SEASON = null;  // the season the user is viewing
  var SEASONS = [];

  // In-memory cache: season+pitcher → flattened pitch rows
  var sessionCache = {};
  function cacheKey(season, pitcherId) { return season + '|' + pitcherId; }

  /* ── 3. NAME HELPERS ─────────────────────────────────────── */
  function docId(name) { return String(name).trim().replace(/[^a-zA-Z0-9]+/g, '_'); }

  function toLastFirst(name) {
    var n = String(name).trim();
    if (n.indexOf(',') !== -1) return n;
    var w = n.split(/\s+/);
    if (w.length < 2) return n;
    return w[w.length - 1] + ', ' + w.slice(0, -1).join(' ');
  }
  function toFirstLast(name) {
    var n = String(name).trim();
    if (n.indexOf(',') === -1) return n;
    var p = n.split(',');
    return p[1].trim() + ' ' + p[0].trim();
  }
  // Resolve any "First Last" / "Last, First" input to the canonical doc id
  function resolveId(name) { return docId(toFirstLast(name)); }

  function lastNameSort(a, b) {
    var la = toFirstLast(a).trim().split(' ').pop().toLowerCase();
    var lb = toFirstLast(b).trim().split(' ').pop().toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  }

  /* ── 4. CONFIG / SEASON LOADING ──────────────────────────── */
  async function loadConfig() {
    var snap = await db.collection('config').doc('app').get();
    if (snap.exists) {
      var c = snap.data();
      CURRENT_SEASON = String(c.currentSeason);
      SEASONS = (c.seasons || [CURRENT_SEASON]).map(String);
    } else {
      // First run, nothing seeded yet — default to this calendar year
      CURRENT_SEASON = String(new Date().getFullYear());
      SEASONS = [CURRENT_SEASON];
    }
    // Newest first in the dropdown
    SEASONS.sort(function (a, b) { return Number(b) - Number(a); });
    SELECTED_SEASON = CURRENT_SEASON;
    publishSeasonInfo();
  }

  function publishSeasonInfo() {
    window.__seasonInfo = { current: CURRENT_SEASON, selected: SELECTED_SEASON };
  }

  async function loadRoster() {
    try {
      var snap = await db.collection('seasons').doc(CURRENT_SEASON).get();
      if (!snap.exists) return;
      var roster = snap.data().roster || [];
      if (!roster.length) return;
      var sel = document.getElementById('pitcher');
      if (!sel) return;
      var prev = sel.value;
      sel.innerHTML = '<option value="">— Select Pitcher —</option>';
      roster.slice().sort(lastNameSort).forEach(function (n) {
        var o = document.createElement('option');
        o.value = n; o.textContent = n;
        sel.appendChild(o);
      });
      if (prev && roster.indexOf(prev) !== -1) sel.value = prev;
    } catch (e) { /* keep the hardcoded fallback roster */ }
  }

  // Fill a season <select> (the leaderboard and video filter rows each
  // build one and call this). Newest season first, current marked.
  function populateSeasonSelect(sel) {
    if (!sel) return;
    sel.innerHTML = '';
    SEASONS.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s;
      o.textContent = s + (s === CURRENT_SEASON ? ' (current)' : '');
      sel.appendChild(o);
    });
    sel.value = SELECTED_SEASON;
    sel.onchange = function () { window.onSeasonChange(this.value); };
  }
  window.populateSeasonSelect = populateSeasonSelect;

  // Called by the season dropdown in index.html
  window.onSeasonChange = function (season) {
    if (!season || season === SELECTED_SEASON) return;
    SELECTED_SEASON = String(season);
    publishSeasonInfo();
    // Keep both views' season selects in sync
    document.querySelectorAll('.season-filter-select').forEach(populateSeasonSelect);
    sessionCache = {};
    try { if (typeof clearSkillLbCache === 'function') clearSkillLbCache(); } catch (e) {}
    try { boardOutings = null; } catch (e) {}
    // Force both data views to refetch
    try { dataLoaded = false; videoLoaded = false; } catch (e) {}
    try {
      if (currentView === 'sheet') { if (typeof lbActivity !== 'undefined' && lbActivity !== 'bullpen') loadSkillsLeaderboard(lbActivity); else fetchSheetData(); }
      else if (currentView === 'video') fetchVideoData();
      else if (currentView === 'board') loadBoard(true);
    } catch (e) {}
    if (typeof showToast === 'function') showToast('Viewing ' + SELECTED_SEASON + ' season');
  };

  /* ── 5. STATS HELPERS ────────────────────────────────────── */
  function isExecuted(result) {
    var s = String(result || '').toLowerCase();
    return s.indexOf('exec') !== -1 && s.indexOf('not') === -1;
  }

  function newAgg() { return { e: 0, t: 0, spdSum: 0, spdN: 0, count: 0 }; }

  function addPitchToAgg(agg, p) {
    agg.count++;
    var r = String(p.result || '');
    if (r) {
      agg.t++;
      if (isExecuted(r)) agg.e++;
    }
    var v = parseFloat(p.velo);
    if (!isNaN(v) && v > 0) { agg.spdSum += v; agg.spdN++; }
  }

  function pct(e, t) { return t > 0 ? Math.round(e / t * 1000) / 10 : 0; }
  function avg(sum, n) { return n > 0 ? Math.round(sum / n * 10) / 10 : 0; }

  function normType(t) {
    var u = String(t || '').trim().toUpperCase();
    return u === 'CB' ? 'BB' : u; // legacy CB → BB
  }

  // Build the summary object stored on each pitcher doc
  function computeSummary(name, allPitches) {
    var by = { FA: newAgg(), BB: newAgg(), CH: newAgg() };
    var tot = newAgg();
    allPitches.forEach(function (p) {
      var t = normType(p.pitchType || p.type);
      if (!by[t]) return;
      addPitchToAgg(by[t], p);
      addPitchToAgg(tot, p);
    });
    return {
      name: name,
      exec: pct(tot.e, tot.t),
      faAvg: avg(by.FA.spdSum, by.FA.spdN), faExec: pct(by.FA.e, by.FA.t),
      cbAvg: avg(by.BB.spdSum, by.BB.spdN), cbExec: pct(by.BB.e, by.BB.t),
      chAvg: avg(by.CH.spdSum, by.CH.spdN), chExec: pct(by.CH.e, by.CH.t),
      faCount: by.FA.count, cbCount: by.BB.count, chCount: by.CH.count,
      totalPitches: tot.count,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
  }

  // #11 — enable offline persistence so a save with no signal queues and
  // syncs when the connection returns. Wrapped because it can only run once
  // and throws if multiple tabs are open (harmless — falls back to online).
  function enableOffline() {
    try {
      db.enablePersistence({ synchronizeTabs: true }).catch(function () {});
    } catch (e) {}
  }

  /* ── 6. FIRESTORE READS ──────────────────────────────────── */
  function pitchersCol(season) {
    return db.collection('seasons').doc(String(season)).collection('pitchers');
  }
  function videosCol(season) {
    return db.collection('seasons').doc(String(season)).collection('videos');
  }
  // Game stats (GameChanger imports) live in a top-level, cross-season
  // collection so a player's Baseball-Reference history spans every team.
  function playersCol() { return db.collection('players'); }
  function ipToOuts(ip) {
    if (ip == null) return 0;
    var s = String(ip), m = s.match(/^(\d+)(?:\.(\d))?$/);
    if (!m) { var v = parseFloat(s); return isNaN(v) ? 0 : Math.round(v * 3); }
    return parseInt(m[1], 10) * 3 + (m[2] ? parseInt(m[2], 10) : 0);
  }

  // Read every session for one pitcher and flatten to pitch rows
  // (shared by fetch_player, fetch_location, and summary recompute)
  async function getPitchRows(season, pitcherId, skipCache) {
    var key = cacheKey(season, pitcherId);
    if (!skipCache && sessionCache[key]) return sessionCache[key];
    var snap = await pitchersCol(season).doc(pitcherId).collection('sessions').get();
    var rows = [];
    snap.forEach(function (doc) {
      var s = doc.data();
      (s.pitches || []).forEach(function (p) {
        rows.push({
          date: s.date,
          num: p.number,
          velo: p.velo,
          type: normType(p.pitchType || p.type),
          exec: p.result || '',
          zone: p.zone || '',
          pitchType: p.pitchType, result: p.result // raw fields for summary calc
        });
      });
    });
    sessionCache[key] = rows;
    return rows;
  }

  // #2 — build a lightweight rollup of the most recent 5 sessions so the
  // common "expand a pitcher" case can show recent form without reading the
  // full sessions subcollection. One small array on the summary doc.
  function recentSessions(rows) {
    var byDate = {};
    rows.forEach(function (r) {
      var d = String(r.date || '').trim();
      if (!d) return;
      if (!byDate[d]) byDate[d] = { date: d, thrown: 0, exec: 0, veloSum: 0, veloN: 0 };
      var s = byDate[d];
      s.thrown++;
      var res = String(r.result || r.exec || '').toLowerCase();
      if (res.indexOf('exec') !== -1 && res.indexOf('not') === -1) s.exec++;
      var v = parseFloat(r.velo);
      if (!isNaN(v) && v > 0) { s.veloSum += v; s.veloN++; }
    });
    return Object.keys(byDate)
      .map(function (d) { return byDate[d]; })
      .sort(function (a, b) { return new Date(b.date) - new Date(a.date); })
      .slice(0, 5)
      .map(function (s) {
        return {
          date: s.date,
          pitches: s.thrown,
          exec: s.thrown ? Math.round(s.exec / s.thrown * 100) : 0,
          avgVelo: s.veloN ? Math.round(s.veloSum / s.veloN * 10) / 10 : 0
        };
      });
  }

  // Recompute a pitcher's season summary from their session docs
  async function recomputeSummary(name, id) {
    var rows = await getPitchRows(CURRENT_SEASON, id, true);
    var summary = computeSummary(name, rows);
    summary.recentSessions = recentSessions(rows);
    await pitchersCol(CURRENT_SEASON).doc(id).set(summary);
  }

  // Recompute a player's hub summary from ALL of their game statlines
  // (career batting/pitching headline + positions + which levels they've played).
  async function recomputePlayer(id) {
    var snap = await playersCol().doc(id).collection('statlines').get();
    var name = id.replace(/_/g, ' '), number = null;
    var bat = { AB: 0, H: 0, BB: 0, HBP: 0, SF: 0, TB: 0, HR: 0, SO: 0, PA: 0, RBI: 0, SB: 0 };
    var pit = { outs: 0, ER: 0, H: 0, BB: 0, SO: 0, eraW: 0 };
    var positions = {}, levels = [], years = [], anyBat = false, anyPit = false, anyFld = false;
    snap.forEach(function (s) {
      var d = s.data();
      if (d.name) name = d.name;
      if (d.number && !number) number = d.number;
      if (d.levelKey && levels.indexOf(d.levelKey) === -1) levels.push(d.levelKey);
      if (d.year && years.indexOf(String(d.year)) === -1) years.push(String(d.year));
      if (d.bat) { anyBat = true; var b = d.bat; ['AB', 'H', 'BB', 'HBP', 'SF', 'TB', 'HR', 'SO', 'PA', 'RBI', 'SB'].forEach(function (k) { bat[k] += (+b[k] || 0); }); }
      if (d.pit) { anyPit = true; var p = d.pit; var pip = ipToOuts(p.IP) / 3; pit.outs += ipToOuts(p.IP); pit.ER += (+p.ER || 0); pit.H += (+p.H || 0); pit.BB += (+p.BB || 0); pit.SO += (+p.SO || 0); pit.eraW += (parseFloat(p.ERA) || 0) * pip; }
      if (d.fld) { anyFld = true; var f = d.fld; if (f.pos) Object.keys(f.pos).forEach(function (po) { positions[po] = (positions[po] || 0) + (+f.pos[po] || 0); }); }
    });
    function f3(x) { return (Math.round(x * 1000) / 1000).toFixed(3).replace(/^0/, ''); }
    var summary = {
      name: name, number: number,
      bats: anyBat, pitches: anyPit, fields: anyFld, levels: levels, years: years,
      positions: Object.keys(positions).sort(function (a, b) { return positions[b] - positions[a]; }),
      statlineCount: snap.size,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (anyBat && bat.AB > 0) {
      var avg = bat.H / bat.AB;
      var obpDen = bat.AB + bat.BB + bat.HBP + bat.SF;
      var obp = obpDen ? (bat.H + bat.BB + bat.HBP) / obpDen : 0;
      var slg = bat.TB / bat.AB;
      summary.AVG = f3(avg); summary.OBP = f3(obp); summary.SLG = f3(slg); summary.OPS = f3(obp + slg);
      summary.HR = bat.HR; summary.SB = bat.SB; summary.RBI = bat.RBI;
    }
    if (anyPit && pit.outs > 0) {
      var ip = pit.outs / 3;
      summary.ERA = (pit.eraW / ip).toFixed(2);
      summary.WHIP = ((pit.H + pit.BB) / ip).toFixed(2);
      summary.SO = pit.SO;
    }
    await playersCol().doc(id).set(summary, { merge: true });
  }

  /* ── 7. ACTION HANDLERS ──────────────────────────────────── */
  var handlers = {

    check_tab: async function (params) {
      var id = resolveId(params.pitcher);
      var snap = await pitchersCol(CURRENT_SEASON).doc(id).get();
      return { success: true, exists: snap.exists };
    },

    create_tab: async function (params) {
      var name = toFirstLast(params.pitcher).trim();
      var id = docId(name);
      await pitchersCol(CURRENT_SEASON).doc(id).set(
        computeSummary(name, []), { merge: true }
      );
      return { success: true };
    },

    export: async function (params) {
      var name = toFirstLast(params.pitcher).trim();
      var id = docId(name);
      var pitches = JSON.parse(params.pitches);
      var session = String(params.session || 'Bullpen');

      // 1) Write the session document
      await pitchersCol(CURRENT_SEASON).doc(id).collection('sessions').add({
        date: params.date,
        sessionType: session,
        season: CURRENT_SEASON,
        pitches: pitches,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // 2) Recompute the pitcher's season summary from all sessions
      //    (sessions are the single source of truth)
      await recomputeSummary(name, id);

      return { success: true, rowsAdded: pitches.length, startRow: '—' };
    },

    fetch_all: async function () {
      var snap = await pitchersCol(SELECTED_SEASON).get();
      var headers = ['Name', 'Exec.', 'FA Avg', 'FA Exec.', 'CB Avg', 'CB Exec.', 'CH Avg', 'CH Exec.'];
      var data = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        data.push({
          'Name': toLastFirst(d.name || doc.id.replace(/_/g, ' ')),
          'Exec.': d.exec || 0,
          'FA Avg': d.faAvg || 0, 'FA Exec.': d.faExec || 0,
          'CB Avg': d.cbAvg || 0, 'CB Exec.': d.cbExec || 0,
          'CH Avg': d.chAvg || 0, 'CH Exec.': d.chExec || 0,
          'fa_count': d.faCount || 0, 'cb_count': d.cbCount || 0, 'ch_count': d.chCount || 0,
          'recentSessions': d.recentSessions || []
        });
      });
      return { success: true, data: data, headers: headers };
    },

    fetch_sessions: async function (params) {
      var id = resolveId(params.pitcher);
      var snap = await pitchersCol(SELECTED_SEASON).doc(id).collection('sessions').get();
      var data = [];
      snap.forEach(function (doc) {
        var s = doc.data();
        data.push({
          id: doc.id,
          date: s.date,
          sessionType: s.sessionType || 'Bullpen',
          pitches: s.pitches || []
        });
      });
      data.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
      return { success: true, data: data };
    },

    update_session: async function (params) {
      var name = toFirstLast(params.pitcher).trim();
      var id = docId(name);
      var pitches = JSON.parse(params.pitches);
      await pitchersCol(CURRENT_SEASON).doc(id).collection('sessions').doc(params.sessionId).set({
        date: params.date,
        sessionType: String(params.session || 'Bullpen'),
        season: CURRENT_SEASON,
        pitches: pitches,
        editedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      await recomputeSummary(name, id);
      return { success: true };
    },

    delete_session: async function (params) {
      var name = toFirstLast(params.pitcher).trim();
      var id = docId(name);
      await pitchersCol(CURRENT_SEASON).doc(id).collection('sessions').doc(params.sessionId).delete();
      await recomputeSummary(name, id);
      return { success: true };
    },

    add_video: async function (params) {
      var name = toFirstLast(params.pitcher).trim();
      var id = docId(name);
      await videosCol(CURRENT_SEASON).doc(id).set({
        name: name,
        videos: firebase.firestore.FieldValue.arrayUnion({ date: params.date, url: params.url })
      }, { merge: true });
      return { success: true };
    },

    remove_video: async function (params) {
      var name = toFirstLast(params.pitcher).trim();
      var id = docId(name);
      await videosCol(CURRENT_SEASON).doc(id).set({
        videos: firebase.firestore.FieldValue.arrayRemove({ date: params.date, url: params.url })
      }, { merge: true });
      return { success: true };
    },

    // #12 — start a new season: bump config and seed the new roster doc.
    // Old seasons become read-only automatically (security rules key off
    // currentSeason). Carries the prior roster forward as a starting point.
    start_season: async function (params) {
      var newSeason = String(params.season).trim();
      if (!/^\d{4}$/.test(newSeason)) return { success: false, error: 'Season must be a 4-digit year' };
      var roster = [];
      try { roster = JSON.parse(params.roster || '[]'); } catch (e) {}
      // Seed the new season doc (roster) first
      await db.collection('seasons').doc(newSeason).set({ year: newSeason, roster: roster }, { merge: true });
      // Flip config. Write seasons[] as a CONCRETE array (not arrayUnion) so the
      // forward-only security rule can validate it deterministically — the rule
      // requires the new list to still contain every existing season. Read the
      // live config first so we merge onto the authoritative list, never a stale
      // in-memory copy.
      var cfgSnap = await db.collection('config').doc('app').get();
      var existingSeasons = (cfgSnap.exists && cfgSnap.data().seasons) || [];
      var mergedSeasons = existingSeasons.slice();
      if (mergedSeasons.indexOf(newSeason) === -1) mergedSeasons.push(newSeason);
      await db.collection('config').doc('app').set({
        currentSeason: newSeason,
        seasons: mergedSeasons
      }, { merge: true });
      // Update in-memory state so the app reflects it without a reload
      CURRENT_SEASON = newSeason;
      if (SEASONS.indexOf(newSeason) === -1) SEASONS.push(newSeason);
      SEASONS.sort(function (a, b) { return Number(b) - Number(a); });
      SELECTED_SEASON = newSeason;
      publishSeasonInfo();
      sessionCache = {};
      return { success: true, season: newSeason };
    },

    // Return the current-season roster so the rollover UI can prefill it
    fetch_roster: async function () {
      var snap = await db.collection('seasons').doc(CURRENT_SEASON).get();
      return { success: true, roster: (snap.exists && snap.data().roster) || [] };
    },

    // Player detail — read one pitcher across ALL seasons for the player card.
    // Returns per-season summary rows (for the table + trend charts) and the
    // tagged zone pitches (for the command-by-zone heat map and location map).
    fetch_player_history: async function (params) {
      var id = resolveId(params.pitcher);
      var name = toFirstLast(params.pitcher).trim();
      var seasons = [];
      var zones = [];
      var videos = [];
      for (var i = 0; i < SEASONS.length; i++) {
        var season = SEASONS[i];
        var sumSnap = await pitchersCol(season).doc(id).get();
        var rows = [];
        try { rows = await getPitchRows(season, id); } catch (e) {}
        // Videos tied to this player for this season (library is per-season)
        try {
          var vSnap = await videosCol(season).doc(id).get();
          if (vSnap.exists) {
            (vSnap.data().videos || []).forEach(function (v) {
              videos.push({ season: season, date: v.date || '', url: v.url || '' });
            });
          }
        } catch (e) {}
        var hasSummary = sumSnap.exists;
        if (!hasSummary && !rows.length) continue;
        var d = hasSummary ? sumSnap.data() : {};
        var dates = {};
        rows.forEach(function (r) {
          var dt = String(r.date || '').trim();
          if (dt) dates[dt] = 1;
          if (r.zone && String(r.zone).trim()) {
            zones.push({ season: season, zone: r.zone, type: r.type, exec: r.exec });
          }
        });
        seasons.push({
          season: season,
          exec: d.exec || 0,
          faAvg: d.faAvg || 0, faExec: d.faExec || 0,
          cbAvg: d.cbAvg || 0, cbExec: d.cbExec || 0,
          chAvg: d.chAvg || 0, chExec: d.chExec || 0,
          faCount: d.faCount || 0, cbCount: d.cbCount || 0, chCount: d.chCount || 0,
          totalPitches: d.totalPitches || rows.length,
          sessionCount: Object.keys(dates).length
        });
      }
      // Chronological (oldest → newest) so trend charts read left-to-right
      seasons.sort(function (a, b) { return Number(a.season) - Number(b.season); });
      videos.sort(function (a, b) { return String(b.season).localeCompare(String(a.season)) || String(b.date).localeCompare(String(a.date)); });
      return { success: true, name: toLastFirst(name), seasons: seasons, zones: zones, videos: videos };
    },

    // ── GAME STATS (GameChanger imports) ───────────────────────
    // Write one Baseball-Reference statline per player for this
    // team-season, then recompute each player's hub summary.
    import_stats: async function (params) {
      var meta = JSON.parse(params.meta);
      var players = JSON.parse(params.players);
      var key = [meta.year, meta.term, meta.level].filter(Boolean).join('_').replace(/[^A-Za-z0-9]+/g, '_');
      var touched = [];
      for (var i = 0; i < players.length; i++) {
        var pr = players[i];
        var name = toFirstLast(pr.name).trim();
        var id = docId(name);
        await playersCol().doc(id).collection('statlines').doc(key).set({
          name: name, number: pr.number || null,
          year: meta.year || null, term: meta.term || null,
          level: meta.level || null, levelKey: meta.levelKey || null,
          bat: pr.bat || null, pit: pr.pit || null, fld: pr.fld || null,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        if (touched.indexOf(id) === -1) touched.push(id);
      }
      for (var j = 0; j < touched.length; j++) { await recomputePlayer(touched[j]); }
      return { success: true, imported: players.length, statline: key };
    },

    // Hub directory — one summary doc per player, plus every season's bullpen
    // roster merged in (tagged by year) so the hub's year filter shows full
    // rosters and players appear even before any game stats are imported.
    fetch_players_hub: async function () {
      var byId = {};
      var snap = await playersCol().get();
      snap.forEach(function (doc) {
        var d = doc.data();
        d.id = doc.id;
        d.years = (d.years || []).map(String);
        byId[doc.id] = d;
      });
      // One-time backfill: summaries imported before the years[] field existed
      // get recomputed so the year filter can place them correctly.
      var toFix = Object.keys(byId).filter(function (id) { var p = byId[id]; return !p.pen && (p.statlineCount > 0) && (!p.years || !p.years.length); });
      for (var f = 0; f < toFix.length; f++) {
        try {
          await recomputePlayer(toFix[f]);
          var ds = await playersCol().doc(toFix[f]).get();
          if (ds.exists) { var dd = ds.data(); dd.id = toFix[f]; dd.years = (dd.years || []).map(String); byId[toFix[f]] = dd; }
        } catch (e) {}
      }
      for (var i = 0; i < SEASONS.length; i++) {
        var Y = String(SEASONS[i]);
        try {
          var rs = await db.collection('seasons').doc(Y).get();
          var roster = (rs.exists && rs.data().roster) || [];
          roster.forEach(function (nm) {
            var fn = toFirstLast(nm).trim(), id = docId(fn);
            if (!byId[id]) byId[id] = { id: id, name: fn, bats: false, pitches: false, fields: false, levels: [], positions: [], years: [], pen: true };
            if (byId[id].years.indexOf(Y) === -1) byId[id].years.push(Y);
          });
        } catch (e) {}
      }
      var data = Object.keys(byId).map(function (k) { return byId[k]; });
      var yset = {};
      data.forEach(function (p) { (p.years || []).forEach(function (y) { yset[String(y)] = 1; }); });
      var years = Object.keys(yset).sort(function (a, b) { return Number(b) - Number(a); });
      // Flat statlines (one per player per team-season) power the B-Ref table + team totals.
      function pushLine(pid, d) {
        statlines.push({
          id: pid, name: d.name, number: d.number || null,
          year: d.year != null ? String(d.year) : null, term: d.term || null,
          level: d.level || null, levelKey: d.levelKey || null,
          bat: d.bat || null, pit: d.pit || null, fld: d.fld || null
        });
      }
      var statlines = [];
      try {
        var slSnap = await db.collectionGroup('statlines').get();
        slSnap.forEach(function (s) { pushLine(s.ref.parent.parent ? s.ref.parent.parent.id : null, s.data()); });
      } catch (e) { /* collection-group query denied/unavailable — fall back below */ }
      if (!statlines.length) {
        // Fallback: read each player's statlines directly (authorized by the
        // per-path rule even when the collection-group rule isn't deployed yet).
        for (var pi = 0; pi < data.length; pi++) {
          if (data[pi].pen) continue; // roster-only entries have no statlines
          try {
            var sub = await playersCol().doc(data[pi].id).collection('statlines').get();
            sub.forEach(function (s) { pushLine(data[pi].id, s.data()); });
          } catch (e2) {}
        }
      }
      return { success: true, data: data, years: years, statlines: statlines };
    },

    // All statlines for one player (Hitting/Pitching/Fielding tabs),
    // oldest → newest so the B-Ref table reads top-down.
    fetch_player_stats: async function (params) {
      var id = resolveId(params.pitcher);
      var sumSnap = await playersCol().doc(id).get();
      var snap = await playersCol().doc(id).collection('statlines').get();
      var lines = [];
      snap.forEach(function (s) { lines.push(Object.assign({ key: s.id }, s.data())); });
      var termOrder = { Spring: 1, Summer: 2, Fall: 3, Winter: 4 };
      lines.sort(function (a, b) {
        return (Number(a.year) - Number(b.year)) || ((termOrder[a.term] || 0) - (termOrder[b.term] || 0));
      });
      return { success: true, summary: sumSnap.exists ? sumSnap.data() : null, statlines: lines };
    },

    fetch_videos: async function () {
      var snap = await videosCol(SELECTED_SEASON).get();
      var data = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        data.push({ name: toLastFirst(d.name || ''), videos: d.videos || [] });
      });
      data.sort(function (a, b) { return lastNameSort(a.name, b.name); });
      return { success: true, data: data };
    },

    /* ── v26: MSHSL availability board ─────────────────────── */
    // Game outings live per-season so the season-lock rules apply.
    log_outing: async function (params) {
      var pitches = parseInt(params.pitches, 10);
      if (!params.pitcher || !params.date || !(pitches > 0)) {
        return { success: false, error: 'Pitcher, date and pitch count are required' };
      }
      await db.collection('seasons').doc(CURRENT_SEASON).collection('outings').add({
        pitcher: toFirstLast(String(params.pitcher)).trim(),
        date: String(params.date),
        pitches: pitches,
        season: CURRENT_SEASON,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      return { success: true };
    },
    fetch_outings: async function () {
      var snap = await db.collection('seasons').doc(SELECTED_SEASON).collection('outings').get();
      var data = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        data.push({ id: doc.id, pitcher: d.pitcher, date: d.date, pitches: d.pitches });
      });
      data.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
      return { success: true, data: data };
    },
    delete_outing: async function (params) {
      if (!params.id) return { success: false, error: 'Missing outing id' };
      await db.collection('seasons').doc(CURRENT_SEASON).collection('outings').doc(String(params.id)).delete();
      return { success: true };
    },
    // Rest-rule table stored on the current season doc (merge keeps roster).
    fetch_board_config: async function () {
      var snap = await db.collection('seasons').doc(SELECTED_SEASON).get();
      var d = snap.exists ? (snap.data() || {}) : {};
      return { success: true, rules: d.restRules || null };
    },
    save_board_config: async function (params) {
      var rules = JSON.parse(params.rules);
      await db.collection('seasons').doc(CURRENT_SEASON).set({ restRules: rules }, { merge: true });
      return { success: true };
    },

    /* ── v26: skill sessions (pop times · sprints · BP rounds) ── */
    save_skill_session: async function (params) {
      if (!params.player || !params.date || !params.kind) {
        return { success: false, error: 'Player, date and session type are required' };
      }
      await db.collection('seasons').doc(CURRENT_SEASON).collection('skillSessions').add({
        player: toFirstLast(String(params.player)).trim(),
        date: String(params.date),
        kind: String(params.kind),
        data: JSON.parse(params.data || '{}'),
        season: CURRENT_SEASON,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      return { success: true };
    },
    fetch_skill_sessions: async function (params) {
      var snap = await db.collection('seasons').doc(SELECTED_SEASON).collection('skillSessions').get();
      var data = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        if (params.player && d.player !== params.player) return;
        if (params.kind && d.kind !== params.kind) return;
        data.push({ id: doc.id, player: d.player, date: d.date, kind: d.kind, data: d.data || {} });
      });
      data.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
      // limit omitted → default 10 (tracker recent list); limit:0 → all (leaderboards / card history)
      var lim = (params.limit === 0 || params.limit === '0') ? 0 : (parseInt(params.limit, 10) || 10);
      return { success: true, data: lim ? data.slice(0, lim) : data };
    }
  };

  /* ── 8. THE INTERCEPT ────────────────────────────────────── */
  // The app calls gasJsonp(url, params[, timeout]). We replace it.
  // baseUrl is ignored — kept only for signature compatibility.
  async function firebaseCall(params) {
    if (initError) return { success: false, error: initError.message };
    if (!db) return { success: false, error: 'Firebase not initialized' };
    if (CURRENT_SEASON === null) await readyPromise;
    var action = params.action;
    var fn = handlers[action];
    if (!fn) return { success: false, error: 'Unknown action: ' + action };
    try {
      return await fn(params);
    } catch (e) {
      console.error('[firebase-data-layer]', action, e);
      return { success: false, error: e.message || String(e) };
    }
  }

  window.gasJsonp = function (baseUrl, params) { return firebaseCall(params); };
  window.gasCall = function (baseUrl, params) { return firebaseCall(params); };

  /* ── 9. BOOT ─────────────────────────────────────────────── */
  var readyResolve;
  var readyPromise = new Promise(function (res) { readyResolve = res; });
  window.__dataLayerReady = readyPromise;

  async function boot() {
    if (initError || !db) {
      console.error('[firebase-data-layer] init failed:', initError);
      readyResolve();
      return;
    }
    try {
      await loadConfig();
      document.querySelectorAll('.season-filter-select').forEach(populateSeasonSelect);
      await loadRoster();
      // Update export modal copy to the live season
      var sub = document.querySelector('#sheetsModal .modal-subtitle');
      if (sub) sub.textContent = 'Save pitch data to the ' + CURRENT_SEASON + ' season';
    } catch (e) {
      console.error('[firebase-data-layer] boot error:', e);
    }
    readyResolve();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
