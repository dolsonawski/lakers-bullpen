/* ============================================================
   PLAYERS HUB  +  UNIFIED PLAYER CARD  (lakers-bullpen)
   ------------------------------------------------------------
   - The hub (#viewPlayers) is the new landing screen: a roster
     directory with search + level/role filters, fed by the
     data layer's `fetch_players_hub` action.
   - The player card grows three Baseball-Reference tabs:
        Hitting · Pitching · Fielding
     Pitching folds in the existing bullpen card (execution table,
     trend charts, command-by-zone heat maps) beneath the game line.

   Loaded AFTER app.js + firebase-data-layer.js + gamechanger-import.js.
   ============================================================ */
(function () {
  'use strict';

  /* ── small stat helpers ──────────────────────────────────── */
  function n(x) { var v = parseFloat(x); return isNaN(v) ? 0 : v; }
  function ipDec(ip) { // "30.1" GC thirds → 30.333…
    if (ip == null) return 0;
    var s = String(ip), m = s.match(/^(\d+)(?:\.(\d))?$/);
    if (!m) return n(s);
    return parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) / 3 : 0);
  }
  function outsToIp(o) { var w = Math.floor(o / 3), r = o % 3; return w + (r ? '.' + r : '.0'); }
  function f3(x) { // .312 style (strip leading zero, keep sign)
    if (!isFinite(x)) return '—';
    var neg = x < 0; x = Math.abs(x);
    var s = x.toFixed(3); s = s.replace(/^0/, '');
    return (neg ? '-' : '') + s;
  }
  function f2(x) { return isFinite(x) ? x.toFixed(2) : '—'; }
  function d2(v) { if (v == null || v === '') return '—'; var x = parseFloat(v); return isFinite(x) ? x.toFixed(2) : dash(v); }
  function f1(x) { return isFinite(x) ? x.toFixed(1) : '—'; }
  function pc(a, b) { return b > 0 ? (a / b * 100).toFixed(1) + '%' : '—'; }
  function dash(v) { return (v == null || v === '') ? '—' : v; }

  /* ── SAMPLE-SIZE GATING ───────────────────────────────────────
     Rate stats (AVG, ERA, K%, FPCT…) only earn the green/red performance
     heat once a line clears a minimum sample. Below it the number still
     shows, but uncolored — so a 2-PA .500 doesn't outrank a real hitter,
     and small samples don't stretch the color ramp. Tune to your season. */
  var MIN_SAMPLE = { hit: 15, pit: 5, fld: 5 };   // min PA · min IP · min TC
  function lineN(l, type) {
    if (type === 'hit') return n(l.bat && l.bat.PA);
    if (type === 'pit') return ipDec(l.pit && l.pit.IP);
    return n(l.fld && l.fld.TC);
  }
  function qualifies(l, type) { return lineN(l, type) >= MIN_SAMPLE[type]; }
  // How an UNQUALIFIED rate cell renders. Swap this ONE function to change the
  // presentation (plain / faded / asterisk / badge — see the mockup).
  function unqualifiedCell(disp) { return pill(disp == null ? '—' : disp, ''); }

  var LVLCSS = { V: 'lvl-V', JV: 'lvl-JV', FR: 'lvl-C', SO: 'lvl-C', C: 'lvl-C', L: 'lvl-L', JL: 'lvl-JL' };
  var LVLSHORT = { V: 'V', JV: 'JV', FR: 'FR', SO: 'SO', C: 'C', L: 'LEG', JL: 'JR' };
  function lvlBadge(key) { return key ? '<span class="lvlbadge ' + (LVLCSS[key] || '') + '">' + (LVLSHORT[key] || key) + '</span>' : ''; }

  /* =========================================================
     PLAYERS HUB
     ========================================================= */
  var hubData = [], hubLines = [], hubLoaded = false, hubYears = [];
  var hubFilters = { q: '', team: '', year: '' };
  var hubStat = 'hit', hubMode = 'trad', hubSortKey = '', hubSortDir = -1;

  var TEAMLABEL = { V: 'Varsity', JV: 'JV', FR: 'Freshman', SO: 'Sophomore', C: 'C-Team', L: 'Legion', JL: 'Jr Legion' };
  var HUBCOLS = {
    hit: { trad: ['G', 'PA', 'AB', 'R', 'H', '2B', '3B', 'HR', 'RBI', 'BB', 'SO', 'SB', 'AVG', 'OBP', 'SLG', 'OPS'],
           adv: ['G', 'PA', 'BB%', 'K%', 'BB/K', 'ISO', 'C%', 'QAB%', 'BABIP', 'PS/PA', 'OPS'] },
    pit: { trad: ['G', 'GS', 'IP', 'W', 'L', 'SV', 'H', 'R', 'ER', 'BB', 'SO', 'HR', 'ERA', 'WHIP'],
           adv: ['IP', 'K%', 'BB%', 'K-BB%', 'K/9', 'BB/9', 'FIP', 'BAA', 'Strike%', 'Whiff%', 'WHIP'] },
    fld: { trad: ['Pos', 'INN', 'TC', 'PO', 'A', 'E', 'DP', 'FPCT'],
           adv: ['Pos', 'INN', 'TC', 'PO', 'A', 'E', 'DP', 'FPCT'] }
  };
  var HUBKEY = { hit: { trad: ['AVG', 'OPS'], adv: ['K%', 'BB%', 'OPS'] }, pit: { trad: ['ERA', 'WHIP'], adv: ['K%', 'FIP', 'WHIP'] }, fld: { trad: ['FPCT'], adv: ['FPCT'] } };

  /* ── rate-stat performance coloring (hub table only) ──────────
     Which columns are rate stats + which direction is "good" (+1 higher,
     -1 lower). Note K% / BB% FLIP meaning between hitters and pitchers.
     Counting stats are absent here, so they never get colored. */
  var RATE_DIR = {
    hit: { 'AVG': 1, 'OBP': 1, 'SLG': 1, 'OPS': 1, 'ISO': 1, 'BB%': 1, 'K%': -1, 'BB/K': 1, 'C%': 1, 'QAB%': 1, 'BABIP': 1, 'PS/PA': 1 },
    pit: { 'ERA': -1, 'WHIP': -1, 'K%': 1, 'BB%': -1, 'K-BB%': 1, 'K/9': 1, 'BB/9': -1, 'FIP': -1, 'BAA': -1, 'Strike%': 1, 'Whiff%': 1 },
    fld: { 'FPCT': 1 }
  };
  function statNum(v) { var f = parseFloat(String(v).replace('%', '')); return isFinite(f) ? f : null; }
  // leaderboard-style green/red ramp (light at the threshold → deep at the extreme)
  function rampColor(good, intensity) {
    if (good) return 'rgb(' + Math.round(200 - intensity * 140) + ',' + Math.round(230 - intensity * 30) + ',' + Math.round(200 - intensity * 140) + ')';
    return 'rgb(' + Math.round(240 - intensity * 30) + ',' + Math.round(180 - intensity * 120) + ',' + Math.round(180 - intensity * 120) + ')';
  }
  // relative within a column; only the high/low extremes earn a color — mid-tier stays plain
  var RATE_TH = 0.40;
  function relColor(v, col, type, st) {
    if (!st || st.min == null || st.max === st.min) return '';
    var x = statNum(v); if (x == null) return '';
    var t = (x - st.min) / (st.max - st.min);
    var dir = (RATE_DIR[type] && RATE_DIR[type][col]) || 1;
    var g = dir > 0 ? t : 1 - t, dev = (g - 0.5) * 2;
    if (Math.abs(dev) < RATE_TH) return '';
    return rampColor(dev > 0, (Math.abs(dev) - RATE_TH) / (1 - RATE_TH));
  }
  // the leaderboard pill: color wraps just the number; rate-plain keeps mid-tier cells aligned
  function pill(disp, color) { return color ? '<span class="rate-pill" style="background:' + color + '">' + disp + '</span>' : '<span class="rate-plain">' + disp + '</span>'; }
  function isRate(type, col) { return !!(RATE_DIR[type] && RATE_DIR[type][col]); }
  // ── player-card coloring MIRRORS the hub ──────────────────────
  // Colors come from where a season ranks among ALL players that year (the same
  // pool the Players tab colors against), not from the player's own seasons.
  var _popMemo = {};
  function clearPopMemo() { _popMemo = {}; }
  function popRanges(year, type, mode) {
    var key = year + '|' + type + '|' + mode;
    if (_popMemo[key]) return _popMemo[key];
    var sect = type === 'hit' ? 'bat' : type === 'pit' ? 'pit' : 'fld';
    var cols = HUBCOLS[type][mode];
    var pool = hubLines.filter(function (l) { return l[sect] && String(l.year) === String(year) && qualifies(l, type); });
    var cellRows = pool.map(function (l) { return type === 'hit' ? hitCells(l, mode) : type === 'pit' ? pitCells(l, mode) : fldCells(l); });
    var byName = {};
    cols.forEach(function (k, ci) {
      if (!isRate(type, k)) return;
      var vals = []; cellRows.forEach(function (cells) { var x = statNum(cells[ci]); if (x != null) vals.push(x); });
      if (vals.length > 1) byName[k] = { min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) };
    });
    _popMemo[key] = byName; return byName;
  }
  // colorize a player's season rows against the league pool for each row's own year
  function colorizeVsPop(statCols, lines, type, mode) {
    return lines.map(function (l) {
      var cells = type === 'hit' ? hitCells(l, mode) : type === 'pit' ? pitCells(l, mode) : fldCells(l);
      var q = qualifies(l, type);
      var ranges = popRanges(l.year, type, mode);
      return cells.map(function (v, ci) {
        var k = statCols[ci];
        if (!isRate(type, k)) return v;
        if (!q) return unqualifiedCell(v);
        return pill(v, ranges[k] ? relColor(v, k, type, ranges[k]) : '');
      });
    });
  }
  // totals/career row → rate cols boxed but never colored, so the column stays aligned
  function boxStatCells(cols, cells, type) {
    return cells.map(function (v, ci) { return isRate(type, cols[ci]) ? pill(v == null ? '—' : v, '') : v; });
  }

  window.loadPlayersHub = async function (force) {
    var loading = document.getElementById('playersLoading');
    var empty = document.getElementById('playersEmpty');
    var tableEl = document.getElementById('playersTable');
    if (hubLoaded && !force) { renderHubGrid(); return; }
    if (loading) loading.style.display = 'block';
    if (tableEl) tableEl.style.display = 'none';
    if (empty) empty.style.display = 'none';
    try {
      var res = await window.gasCall(null, { action: 'fetch_players_hub' });
      hubData = (res && res.data) || [];
      hubLines = (res && res.statlines) || [];
      hubYears = (res && res.years) || [];
      hubLoaded = true;
      buildHubFilters();
      renderHubGrid();
    } catch (e) {
      if (loading) loading.innerHTML = '<p>Could not load players: ' + e.message + '</p>';
      return;
    }
    if (loading) loading.style.display = 'none';
  };

  // Exposed so the importer matches against EVERY known player (roster + anyone
  // already added via a prior import + every name on a statline).
  window.getKnownPlayerNames = function () {
    var names = {};
    hubData.forEach(function (p) { if (p.name) names[p.name] = 1; });
    hubLines.forEach(function (l) { if (l.name) names[l.name] = 1; });
    var sel = document.getElementById('pitcher');
    if (sel) for (var i = 0; i < sel.options.length; i++) { var v = sel.options[i].value; if (v) names[v] = 1; }
    return Object.keys(names);
  };

  function hubTeamKeys() {
    var lv = {};
    hubLines.forEach(function (l) { if (l.levelKey) lv[l.levelKey] = 1; });
    hubData.forEach(function (p) { (p.levels || []).forEach(function (k) { lv[k] = 1; }); });
    var order = ['V', 'JV', 'FR', 'SO', 'C', 'L', 'JL'];
    return Object.keys(lv).sort(function (a, b) { var ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
  }

  function buildHubFilters() {
    var ysel = document.getElementById('playersYear');
    if (ysel) {
      hubFilters.year = hubYears.length ? hubYears[0] : '';
      ysel.innerHTML = hubYears.length
        ? hubYears.map(function (y) { return '<option value="' + y + '"' + (y === hubFilters.year ? ' selected' : '') + '>' + y + '</option>'; }).join('')
        : '<option value="">All seasons</option>';
    }
    var keys = hubTeamKeys();
    var row = document.getElementById('playersLevelChips');
    if (row) {
      row.innerHTML = '<span class="chip ' + (hubFilters.team === '' ? 'on' : '') + '" data-team="">All Teams</span>' +
        keys.map(function (k) { return '<span class="chip' + (hubFilters.team === k ? ' on' : '') + '" data-team="' + k + '">' + (TEAMLABEL[k] || k) + '</span>'; }).join('');
      row.querySelectorAll('.chip').forEach(function (c) {
        c.onclick = function () { hubFilters.team = c.dataset.team; hubSortKey = ''; renderHubGrid(); };
      });
    }
  }

  /* ---- shared cell builders (mirror the player-card columns exactly) ---- */
  function hitCells(line, mode) {
    var b = line.bat, a = batAgg([line]);
    if (mode === 'trad') return [b.GP, b.PA, b.AB, b.R, b.H, b._2B, b._3B, b.HR, b.RBI, b.BB, b.SO, b.SB, f3(a.AVG), f3(a.OBP), f3(a.SLG), f3(a.OPS)];
    return [b.GP, b.PA, pc(n(b.BB), n(b.PA)), pc(n(b.SO), n(b.PA)), dash(b.BBK), f3(a.SLG - a.AVG), b.Cp ? b.Cp + '%' : '—', b.QABp ? b.QABp + '%' : '—', dash(b.BABIP), d2(b.PSPA), f3(a.OPS)];
  }
  function hitTotals(lines, mode) {
    var c = batAgg(lines); // pooled — team AVG = ΣH/ΣAB, etc.
    if (mode === 'trad') return [c.GP, c.PA, c.AB, c.R, c.H, c._2B, c._3B, c.HR, c.RBI, c.BB, c.SO, c.SB, f3(c.AVG), f3(c.OBP), f3(c.SLG), f3(c.OPS)];
    return [c.GP, c.PA, pc(c.BB, c.PA), pc(c.SO, c.PA), c.SO ? (c.BB / c.SO).toFixed(2) : '—', f3(c.SLG - c.AVG), '—', '—', '—', '—', f3(c.OPS)];
  }
  function pitCells(line, mode) {
    var p = line.pit, ip = ipDec(p.IP);
    if (mode === 'trad') return [p.GP, p.GS, dash(p.IP), p.W, p.L, p.SV, p.H, p.R, p.ER, p.BB, p.SO, p.HR, d2(p.ERA), d2(p.WHIP)];
    return [dash(p.IP), pc(n(p.SO), n(p.BF)), pc(n(p.BB), n(p.BF)), pc(n(p.SO) - n(p.BB), n(p.BF)), ip ? f1(n(p.SO) * 9 / ip) : '—', ip ? f1(n(p.BB) * 9 / ip) : '—', d2(p.FIP), dash(p.BAA), p.Sp ? p.Sp + '%' : '—', p.SMp ? p.SMp + '%' : '—', d2(p.WHIP)];
  }
  function pitTotals(lines, mode) {
    var c = pitAgg(lines), ip = c.ip;
    if (mode === 'trad') return [c.GP, c.GS, outsToIp(c.outs), c.W, c.L, c.SV, c.H, c.R, c.ER, c.BB, c.SO, c.HR, ip ? f2(c.eraW / ip) : '—', ip ? f2((c.H + c.BB) / ip) : '—'];
    return [outsToIp(c.outs), pc(c.SO, c.BF), pc(c.BB, c.BF), pc(c.SO - c.BB, c.BF), ip ? f1(c.SO * 9 / ip) : '—', ip ? f1(c.BB * 9 / ip) : '—', ip ? f2(c.fipW / ip) : '—', '—', '—', '—', ip ? f2((c.H + c.BB) / ip) : '—'];
  }
  function innSum(pos) { var s = 0; if (pos) for (var k in pos) s += pos[k]; return s; }
  function fldCells(line) { var f = line.fld; return [posList(f.pos || {}).slice(0, 3).join('·') || '—', Math.round(innSum(f.pos)), f.TC, f.PO, f.A, f.E, f.DP, dash(f.FPCT)]; }
  function fldTotals(lines) { var c = fldAgg(lines); return [posList(c.pos).slice(0, 3).join('·') || '—', Math.round(innSum(c.pos)), c.TC, c.PO, c.A, c.E, c.DP, c.FPCT]; }

  function renderHubGrid() {
    var thead = document.getElementById('playersThead'), tbody = document.getElementById('playersTbody'), tfoot = document.getElementById('playersTfoot');
    var tableEl = document.getElementById('playersTable'), empty = document.getElementById('playersEmpty');
    if (!tbody) return;
    document.querySelectorAll('#hubStatTabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.s === hubStat); });
    document.querySelectorAll('#hubModeSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.m === hubMode); });
    document.querySelectorAll('#playersLevelChips .chip').forEach(function (c) { c.classList.toggle('on', c.dataset.team === hubFilters.team); });
    var modeSeg = document.getElementById('hubModeSeg'); if (modeSeg) modeSeg.style.display = (hubStat === 'fld') ? 'none' : '';

    var sect = hubStat === 'hit' ? 'bat' : hubStat === 'pit' ? 'pit' : 'fld';
    var mode = hubMode, q = (hubFilters.q || '').toLowerCase();
    var lines = hubLines.filter(function (l) {
      if (!l[sect]) return false;
      if (hubFilters.year && String(l.year) !== hubFilters.year) return false;
      if (hubFilters.team && l.levelKey !== hubFilters.team) return false;
      if (q && String(l.name || '').toLowerCase().indexOf(q) === -1) return false;
      return true;
    });

    if (!lines.length) {
      if (tableEl) tableEl.style.display = 'none';
      if (empty) { empty.style.display = 'block'; empty.querySelector('p').textContent = hubLines.length ? 'No ' + (hubStat === 'hit' ? 'hitting' : hubStat === 'pit' ? 'pitching' : 'fielding') + ' stats for this team & season.' : 'No players yet — import a GameChanger stats file to get started.'; }
      return;
    }
    if (empty) empty.style.display = 'none';
    if (tableEl) tableEl.style.display = '';

    var cols = HUBCOLS[hubStat][mode], showPos = hubStat === 'hit', keyset = HUBKEY[hubStat][mode];
    var rows = lines.map(function (l) {
      var cells = hubStat === 'hit' ? hitCells(l, mode) : hubStat === 'pit' ? pitCells(l, mode) : fldCells(l);
      var pos = (l.fld && l.fld.pos) ? (posList(l.fld.pos)[0] || '') : '';
      return { name: l.name, num: l.number, lvl: l.levelKey, pos: pos, cells: cells, q: qualifies(l, hubStat) };
    });
    // sort
    if (hubSortKey === '__name') rows.sort(function (a, b) { return a.name.localeCompare(b.name) * hubSortDir; });
    else if (hubSortKey) { var ci = cols.indexOf(hubSortKey); if (ci >= 0) rows.sort(function (a, b) { var av = parseFloat(a.cells[ci]), bv = parseFloat(b.cells[ci]); if (isNaN(av) && isNaN(bv)) return 0; if (isNaN(av)) return 1; if (isNaN(bv)) return -1; return (av - bv) * hubSortDir; }); }
    else { var dk = hubStat === 'hit' ? 'OPS' : hubStat === 'pit' ? 'ERA' : 'FPCT', di = cols.indexOf(dk), dir = hubStat === 'pit' ? 1 : -1; if (di >= 0) rows.sort(function (a, b) { var av = parseFloat(a.cells[di]), bv = parseFloat(b.cells[di]); if (isNaN(av)) return 1; if (isNaN(bv)) return -1; return (av - bv) * dir; }); }

    var head = '<tr><th class="lft sortable" data-k="__name">Player</th><th class="lft">#</th>' + (showPos ? '<th class="lft">Pos</th>' : '') + '<th class="lft">Team</th>';
    cols.forEach(function (cl) { head += '<th class="sortable' + (cl === 'Pos' ? ' lft' : '') + '" data-k="' + cl + '">' + cl + (hubSortKey === cl ? (hubSortDir < 0 ? ' ▾' : ' ▴') : '') + '</th>'; });
    thead.innerHTML = head + '</tr>';

    // per-rate-column min/max across the players shown — drives the performance heat coloring
    var rateStats = {};
    cols.forEach(function (k, ci) {
      if (!(RATE_DIR[hubStat] && RATE_DIR[hubStat][k])) return;
      var vals = [];
      rows.forEach(function (r) { var x = statNum(r.cells[ci]); if (r.q && x != null) vals.push(x); });
      if (vals.length > 1) rateStats[ci] = { min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) };
    });

    tbody.innerHTML = rows.map(function (r) {
      var pref = hubStat === 'pit' ? ",'pit'" : hubStat === 'fld' ? ",'fld'" : ",'hit'";
      var nm = '<a class="hub-pname" onclick="openPlayerCard(' + JSON.stringify(r.name).replace(/"/g, '&quot;') + pref + ')">' + r.name + '</a>';
      var lead = '<td class="lft">' + nm + '</td><td class="lft num">' + (r.num || '') + '</td>' + (showPos ? '<td class="lft"><span class="pos">' + (r.pos || '') + '</span></td>' : '') + '<td class="lft">' + lvlBadge(r.lvl) + '</td>';
      var tds = r.cells.map(function (v, ci) {
        var k = cols[ci], cls = (k === 'Pos' ? 'lft ' : '') + (keyset.indexOf(k) >= 0 ? 'key' : '');
        var inner = isRate(hubStat, k) ? (r.q ? pill(v == null ? '—' : v, rateStats[ci] ? relColor(v, k, hubStat, rateStats[ci]) : '') : unqualifiedCell(v)) : (v == null ? '—' : v);
        return '<td class="' + cls + '">' + inner + '</td>';
      }).join('');
      return '<tr>' + lead + tds + '</tr>';
    }).join('');

    var totals = hubStat === 'hit' ? hitTotals(lines, mode) : hubStat === 'pit' ? pitTotals(lines, mode) : fldTotals(lines);
    var leadCols = showPos ? 4 : 3;
    var totLead = '<td class="lft tlabel">Team Total</td><td></td>' + (showPos ? '<td></td>' : '') + '<td></td>';
    var totTds = totals.map(function (v, ci) { var k = cols[ci]; var inner = isRate(hubStat, k) ? pill(v == null ? '—' : v, '') : (v == null ? '—' : v); return '<td class="' + (k === 'Pos' ? 'lft ' : '') + 'key">' + inner + '</td>'; }).join('');
    tfoot.innerHTML = '<tr class="totals">' + totLead + totTds + '</tr>' +
      '<tr><td colspan="' + (leadCols + cols.length) + '" class="hub-foot">' + lines.length + ' ' + (hubStat === 'hit' ? 'hitters' : hubStat === 'pit' ? 'pitchers' : 'fielders') + ' · ' + hubFilters.year + (hubFilters.team ? ' ' + (TEAMLABEL[hubFilters.team] || hubFilters.team) : ' · all teams') + ' · totals pool the rows shown (team AVG = total H ÷ total AB) · click a name for the full card</td></tr>';

    thead.querySelectorAll('th.sortable').forEach(function (th) { th.onclick = function () { var k = th.dataset.k; if (hubSortKey === k) hubSortDir *= -1; else { hubSortKey = k; hubSortDir = (k === '__name') ? 1 : -1; } renderHubGrid(); }; });
  }

  // wire hub controls once the DOM is ready
  function wireHub() {
    var search = document.getElementById('playersSearch');
    if (search) search.oninput = function () { hubFilters.q = this.value; renderHubGrid(); };
    var ysel = document.getElementById('playersYear');
    if (ysel) ysel.onchange = function () { hubFilters.year = this.value; hubSortKey = ''; renderHubGrid(); };
    var tabs = document.getElementById('hubStatTabs');
    if (tabs) tabs.querySelectorAll('button').forEach(function (b) { b.onclick = function () { hubStat = b.dataset.s; hubMode = 'trad'; hubSortKey = ''; renderHubGrid(); }; });
    var modeSeg = document.getElementById('hubModeSeg');
    if (modeSeg) modeSeg.querySelectorAll('button').forEach(function (b) { b.onclick = function () { hubMode = b.dataset.m; hubSortKey = ''; renderHubGrid(); }; });
    var drop = document.getElementById('playersDrop');
    if (drop) {
      ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('hot'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('hot'); }); });
      drop.addEventListener('drop', function (e) { var f = e.dataTransfer.files[0]; if (f && window.gcDropFile) window.gcDropFile(f); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireHub); else wireHub();
  (function kick() {
    var v = document.getElementById('viewPlayers');
    if (v && v.classList.contains('active')) window.loadPlayersHub();
  })();

  /* =========================================================
     UNIFIED PLAYER CARD
     ========================================================= */
  var statLines = [];   // game statlines for the open player
  var statSummary = null;
  var pcTab = 'hit', pcMode = 'trad';

  // Called by app.js openPlayerCard() after both fetches resolve.
  window.renderUnifiedPlayerCard = function (preferTab) {
    clearPopMemo();
    var st = window.playerStatsData || {};
    statLines = st.statlines || [];
    statSummary = st.summary || null;
    var bull = playerCardData || { seasons: [] };

    var hasHit = statLines.some(function (l) { return l.bat; });
    var hasPit = statLines.some(function (l) { return l.pit; }) || (bull.seasons && bull.seasons.length);
    var hasFld = statLines.some(function (l) { return l.fld; });

    // header
    document.getElementById('playerCardName').textContent = playerCardCurrentName || (statSummary && statSummary.name) || 'Player';
    document.getElementById('playerCardCareer').innerHTML = careerHeader(hasHit, hasPit, hasFld);

    // pick default tab
    pcTab = (preferTab && { hit: hasHit, pit: hasPit, fld: hasFld }[preferTab]) ? preferTab
      : hasHit ? 'hit' : hasPit ? 'pit' : hasFld ? 'fld' : 'hit';
    pcMode = 'trad';

    var tabBtn = function (id, label, on, has) {
      return '<button class="pcx-tab' + (on ? ' on' : '') + (has ? '' : ' empty') + '" data-side="' + id + '" onclick="pcxTab(\'' + id + '\')">' + label + '</button>';
    };
    document.getElementById('playerCardBody').innerHTML =
      '<div class="pcx-tabs">' +
        tabBtn('hit', '🏏 Hitting', pcTab === 'hit', hasHit) +
        tabBtn('pit', '⚾ Pitching', pcTab === 'pit', hasPit) +
        tabBtn('fld', '🧤 Fielding', pcTab === 'fld', hasFld) +
      '</div>' +
      '<div class="pcx-toolbar" id="pcxToolbar">' +
        '<div class="pcx-seg"><button id="pcxT" class="on" onclick="pcxMode(\'trad\')">Traditional</button><button id="pcxA" onclick="pcxMode(\'adv\')">Advanced</button></div>' +
        '<div class="pcx-hint" id="pcxHint"></div>' +
      '</div>' +
      '<div id="pcxHost"></div>';
    renderTab();
  };

  function careerHeader(hasHit, hasPit, hasFld) {
    var chips = [];
    var s = statSummary || {};
    if (hasHit && s.AVG) { chips.push(['AVG', s.AVG]); chips.push(['OPS', s.OPS]); if (s.HR != null) chips.push(['HR', s.HR]); }
    if (hasPit && s.ERA) { chips.push(['ERA', d2(s.ERA)]); chips.push(['WHIP', d2(s.WHIP)]); }
    var bull = playerCardData || {};
    var bp = (bull.seasons || []).reduce(function (a, x) { return a + (x.totalPitches || 0); }, 0);
    if (bp) chips.push(['Pen', bp + 'p']);
    if (!chips.length) return 'No game stats imported yet';
    return chips.map(function (c) { return '<span class="pcx-chip"><b>' + c[1] + '</b> ' + c[0] + '</span>'; }).join('');
  }

  window.pcxTab = function (t) {
    var btn = document.querySelector('.pcx-tab[data-side="' + t + '"]');
    if (btn && btn.classList.contains('empty')) { /* still allow, shows empty state */ }
    pcTab = t; pcMode = 'trad';
    document.querySelectorAll('.pcx-tab').forEach(function (b) { b.classList.toggle('on', b.dataset.side === t); });
    renderTab();
  };
  window.pcxMode = function (m) {
    pcMode = m;
    document.getElementById('pcxT').classList.toggle('on', m === 'trad');
    document.getElementById('pcxA').classList.toggle('on', m === 'adv');
    renderTab();
  };

  function renderTab() {
    // relabel the toggle per tab
    var T = document.getElementById('pcxT'), A = document.getElementById('pcxA');
    var seg = T.parentNode;
    if (pcTab === 'fld') { seg.style.display = 'none'; }
    else {
      seg.style.display = ''; T.textContent = 'Traditional'; A.textContent = 'Advanced';
      T.classList.toggle('on', pcMode === 'trad'); A.classList.toggle('on', pcMode === 'adv');
    }

    var hints = {
      hit: { trad: 'Standard box score · one row per level & year', adv: 'Rate stats — Swing% isn’t in the export, so Contact% (C%) + QAB% stand in' },
      pit: { trad: 'Game results · one row per level & year — bullpen work folds in below', adv: 'FIP, K%, BB%, BAA from GameChanger — CSW% left out; Strike% + Whiff% stand in' },
      fld: { trad: 'Fielding line per year · positions & catching below', adv: 'Fielding line per year · positions & catching below' }
    };
    document.getElementById('pcxHint').textContent = hints[pcTab][pcMode];

    var host = document.getElementById('pcxHost');
    if (pcTab === 'hit') host.innerHTML = renderHitting();
    else if (pcTab === 'fld') host.innerHTML = renderFielding();
    else { // pitching: game line + profile + trend + videos + bullpen
      var pg = renderPitchingGame();
      host.innerHTML = pg + profileSection('pit') + sparkSection('pit') + (pg ? levelLegend() : '') + renderVideos() + renderBullpenFold();
      // draw the bullpen charts/heatmaps now that the nodes exist
      var seasons = (playerCardData && playerCardData.seasons) || [];
      if (seasons.length) {
        try {
          playerLocYear = seasons[seasons.length - 1].season;
          if (typeof drawTrendCharts === 'function') drawTrendCharts(seasons);
          if (typeof renderPlayerLocation === 'function') renderPlayerLocation();
        } catch (e) { /* non-fatal */ }
      }
    }
  }

  // Video links tied to this player (gathered across seasons by fetch_player_history)
  function renderVideos() {
    var vids = (playerCardData && playerCardData.videos) || [];
    if (!vids.length) return '';
    var items = vids.map(function (v) {
      var meta = [v.date, v.season].filter(Boolean).join(' · ');
      return '<a class="pcx-vid" href="' + v.url + '" target="_blank" rel="noopener">▶ Video' + (meta ? ' <span class="vd">' + meta + '</span>' : '') + '</a>';
    }).join('');
    return '<div class="pc-section"><div class="pc-section-title">🎥 Video</div><div class="pcx-vids">' + items + '</div></div>';
  }

  /* ---- table builder ---- */
  function tbl(cols, rows, lftCount, keyCols) {
    var h = '<div class="stat-scroll"><table class="bref"><thead><tr>';
    cols.forEach(function (c, i) { h += '<th class="' + (i < lftCount ? 'lft' : '') + '">' + c + '</th>'; });
    h += '</tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr class="' + (r.cls || 'hl') + '">';
      r.d.forEach(function (v, i) {
        var cls = i < lftCount ? 'lft' : '';
        if (cols[i] === 'Year') cls += ' yr';
        if (keyCols && keyCols.indexOf(cols[i]) !== -1 && (r.cls || 'hl') === 'hl') cls += ' key';
        h += '<td class="' + cls + '">' + (v == null ? '—' : v) + '</td>';
      });
      h += '</tr>';
    });
    return h + '</tbody></table></div>';
  }
  var TERMABBR = { Spring: 'Sp', Summer: 'Su', Fall: 'Fa', Winter: 'Wi' };
  function termTag(t) { return t ? (TERMABBR[t] || String(t).slice(0, 2)) : ''; }
  function yearLabel(l) { return l.year + (l.term ? ' ' + termTag(l.term) : ''); }
  // group a player's lines by season (year); preserves first-seen order and
  // carries each line's original index so colorized cells stay aligned
  function groupSeasons(lines) {
    var by = {}, order = [];
    lines.forEach(function (l, i) {
      var y = l.year || '';
      if (!by[y]) { by[y] = { year: y, lines: [], idx: [] }; order.push(y); }
      by[y].lines.push(l); by[y].idx.push(i);
    });
    return order.map(function (y) { return by[y]; });
  }
  // B-Ref-style combined line for a multi-team season: year kept, "N Teams" tag,
  // distinct level badges, aggregated stats (boxed, uncolored — it crosses tiers).
  function seasonTotRow(g, statCols, cells, type) {
    var lvls = [];
    g.lines.forEach(function (l) { if (l.levelKey && lvls.indexOf(l.levelKey) === -1) lvls.push(l.levelKey); });
    var badges = lvls.map(lvlBadge).join('');
    var lvlCell = '<span class="tms-cell"><span class="ntm">' + g.lines.length + ' Teams</span>' + badges + '</span>';
    return { cls: 'seasontot', d: [g.year, lvlCell].concat(boxStatCells(statCols, cells, type)) };
  }
  // career splits by level (B-Ref bottom block): one row per level + an All-Levels total.
  // Only shown when the player has 2+ distinct levels (otherwise it duplicates Career).
  var LVLORDER = ['V', 'JV', 'FR', 'SO', 'C', 'L', 'JL'];
  function distinctYears(lines) { var y = {}; lines.forEach(function (l) { if (l.year != null) y[l.year] = 1; }); return Object.keys(y).length; }
  function buildSplits(lines, type, statCols, cellsFor, keyCols, lft) {
    var byLvl = {};
    lines.forEach(function (l) { var k = l.levelKey || '—'; if (!byLvl[k]) byLvl[k] = []; byLvl[k].push(l); });
    var keys = Object.keys(byLvl);
    if (keys.length < 2) return '';
    keys.sort(function (a, b) { var ia = LVLORDER.indexOf(a), ib = LVLORDER.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
    var cols = ['Level', 'Sea'].concat(statCols);
    var rows = keys.map(function (k) {
      return { d: [TEAMLABEL[k] || k, distinctYears(byLvl[k])].concat(boxStatCells(statCols, cellsFor(byLvl[k]), type)) };
    });
    rows.push({ cls: 'career', d: ['All Levels', distinctYears(lines)].concat(boxStatCells(statCols, cellsFor(lines), type)) });
    return '<div class="splits-h">Career splits by level</div>' + tbl(cols, rows, lft || 2, keyCols);
  }

  /* =========================================================
     PERCENTILE PROFILE  (Baseball-Savant style)  +  TRENDS
     ---------------------------------------------------------
     Two comparison TIERS:
       upper = Varsity + Legion        (V · L)
       lower = JV + Freshman + Jr Legion (+ Sophomore / C-team)
     A season line is ranked against ALL same-tier QUALIFIED lines
     across every imported year — the pool deepens as seasons import.
     ========================================================= */
  var TIER = { V: 'up', L: 'up', JV: 'lo', FR: 'lo', JL: 'lo', SO: 'lo', C: 'lo' };
  function tierOf(k) { return TIER[k] || 'lo'; }
  function _r(v) { var f = parseFloat(v); return isFinite(f) ? f : null; }

  // direction-aware percentile rank; null if value missing or pool too thin
  function pctRank(val, poolVals, dir) {
    if (val == null || !isFinite(val)) return null;
    var arr = poolVals.filter(function (x) { return x != null && isFinite(x); });
    if (arr.length < 3) return null;                 // not enough history yet
    var below = 0, equal = 0;
    arr.forEach(function (x) { if (x < val) below++; else if (x === val) equal++; });
    var p = (below + equal * 0.5) / arr.length;
    if (dir < 0) p = 1 - p;                           // lower-is-better stats invert
    return Math.max(1, Math.min(99, Math.round(p * 100)));
  }

  // blue → gray → red ramp keyed on percentile (0..100)
  function _lerp(a, b, t) { return Math.round(a + (b - a) * t); }
  function _mix(c1, c2, t) { return 'rgb(' + _lerp(c1[0], c2[0], t) + ',' + _lerp(c1[1], c2[1], t) + ',' + _lerp(c1[2], c2[2], t) + ')'; }
  var _BL = [63, 127, 214], _GY = [138, 151, 166], _RD = [224, 49, 75];
  function pctColor(p) { var t = p / 100; return t <= 0.5 ? _mix(_BL, _GY, t / 0.5) : _mix(_GY, _RD, (t - 0.5) / 0.5); }

  // stat specs: value getter · good-direction · display formatter
  var HITPROF = [
    { k: 'AVG', dir: 1, get: function (l) { return batAgg([l]).AVG; }, fmt: function (v) { return f3(v); } },
    { k: 'OBP', dir: 1, get: function (l) { return batAgg([l]).OBP; }, fmt: function (v) { return f3(v); } },
    { k: 'OPS', dir: 1, get: function (l) { return batAgg([l]).OPS; }, fmt: function (v) { return f3(v); } },
    { k: 'ISO', dir: 1, get: function (l) { var a = batAgg([l]); return a.SLG - a.AVG; }, fmt: function (v) { return f3(v); } },
    { k: 'SLG', dir: 1, get: function (l) { return batAgg([l]).SLG; }, fmt: function (v) { return f3(v); } },
    { k: 'BB%', dir: 1, get: function (l) { var b = l.bat; return n(b.PA) ? n(b.BB) / n(b.PA) * 100 : null; }, fmt: function (v) { return v.toFixed(1) + '%'; } },
    { k: 'K%', dir: -1, get: function (l) { var b = l.bat; return n(b.PA) ? n(b.SO) / n(b.PA) * 100 : null; }, fmt: function (v) { return v.toFixed(1) + '%'; } },
    { k: 'BB/K', dir: 1, get: function (l) { var b = l.bat; return n(b.SO) ? n(b.BB) / n(b.SO) : null; }, fmt: function (v) { return v.toFixed(2); } },
    { k: 'Contact%', dir: 1, get: function (l) { return _r(l.bat.Cp); }, fmt: function (v) { return v.toFixed(0) + '%'; } },
    { k: 'QAB%', dir: 1, get: function (l) { return _r(l.bat.QABp); }, fmt: function (v) { return v.toFixed(0) + '%'; } },
    { k: 'BABIP', dir: 1, get: function (l) { return _r(l.bat.BABIP); }, fmt: function (v) { return f3(v); } },
    { k: 'PS/PA', dir: 1, get: function (l) { return _r(l.bat.PSPA); }, fmt: function (v) { return v.toFixed(1); } }
  ];
  var PITPROF = [
    { k: 'ERA', dir: -1, get: function (l) { return _r(l.pit.ERA); }, fmt: function (v) { return v.toFixed(2); } },
    { k: 'FIP', dir: -1, get: function (l) { return _r(l.pit.FIP); }, fmt: function (v) { return v.toFixed(2); } },
    { k: 'WHIP', dir: -1, get: function (l) { return _r(l.pit.WHIP); }, fmt: function (v) { return v.toFixed(2); } },
    { k: 'BAA', dir: -1, get: function (l) { return _r(l.pit.BAA); }, fmt: function (v) { return f3(v); } },
    { k: 'K%', dir: 1, get: function (l) { var p = l.pit; return n(p.BF) ? n(p.SO) / n(p.BF) * 100 : null; }, fmt: function (v) { return v.toFixed(0) + '%'; } },
    { k: 'K-BB%', dir: 1, get: function (l) { var p = l.pit; return n(p.BF) ? (n(p.SO) - n(p.BB)) / n(p.BF) * 100 : null; }, fmt: function (v) { return v.toFixed(0) + '%'; } },
    { k: 'BB%', dir: -1, get: function (l) { var p = l.pit; return n(p.BF) ? n(p.BB) / n(p.BF) * 100 : null; }, fmt: function (v) { return v.toFixed(0) + '%'; } },
    { k: 'Whiff%', dir: 1, get: function (l) { return _r(l.pit.SMp); }, fmt: function (v) { return v.toFixed(0) + '%'; } },
    { k: 'Strike%', dir: 1, get: function (l) { return _r(l.pit.Sp); }, fmt: function (v) { return v.toFixed(0) + '%'; } }
  ];

  function profilePool(type, tier) {
    var sect = type === 'hit' ? 'bat' : 'pit';
    return hubLines.filter(function (l) { return l[sect] && tierOf(l.levelKey) === tier && qualifies(l, type); });
  }
  function profileHead() {
    return '<div class="prow phead"><div></div><div class="pscale">' +
      '<div class="pmark poor" style="left:18%">POOR<i></i></div>' +
      '<div class="pmark avg" style="left:50%">AVERAGE<i></i></div>' +
      '<div class="pmark great" style="left:84%">GREAT<i></i></div>' +
      '</div><div></div></div>';
  }
  function profileRow(label, disp, pct) {
    if (pct == null) {
      return '<div class="prow"><div class="plabel">' + label + '</div>' +
        '<div class="pbar nq"><div class="ptrack"></div></div>' +
        '<div class="pval dim">' + disp + '</div></div>';
    }
    var col = pctColor(pct), left = Math.max(7, Math.min(95, pct));
    return '<div class="prow"><div class="plabel">' + label + '</div>' +
      '<div class="pbar"><div class="ptrack"></div>' +
      '<div class="pfill" style="width:' + pct + '%;background:' + col + '"></div>' +
      '<div class="pbub" style="left:' + left + '%;background:' + col + '">' + pct + '</div></div>' +
      '<div class="pval">' + disp + '</div></div>';
  }
  function buildProfileRows(type, line) {
    var spec = type === 'hit' ? HITPROF : PITPROF;
    var pool = profilePool(type, tierOf(line.levelKey));
    var graded = qualifies(line, type);
    return spec.map(function (s) {
      var val = s.get(line);
      var disp = (val == null || !isFinite(val)) ? '—' : s.fmt(val);
      var pct = graded ? pctRank(val, pool.map(s.get), s.dir) : null;
      return profileRow(s.k, disp, pct);
    }).join('');
  }

  var profileSel = { hit: null, pit: null };
  function profSeasonLines(type) {
    var sect = type === 'hit' ? 'bat' : 'pit';
    return statLines.filter(function (l) { return l[sect]; })
      .slice().sort(function (a, b) { return (n(a.year) - n(b.year)) || 0; });
  }
  function profileSection(type) {
    var lines = profSeasonLines(type);
    if (!lines.length) return '';
    var sel = profileSel[type];
    if (sel == null || sel >= lines.length) sel = lines.length - 1;  // default newest
    profileSel[type] = sel;
    var line = lines[sel], graded = qualifies(line, type);
    var chips = lines.map(function (l, i) {
      var q = qualifies(l, type);
      return '<button class="prof-chip' + (i === sel ? ' on' : '') + '" onclick="pcxProfSel(\'' + type + '\',' + i + ')">' +
        yearLabel(l) + ' ' + (l.levelKey || '') + (q ? '' : '<span class="pnqb">NQ</span>') + '</button>';
    }).join('');
    var banner = graded ? '' :
      '<div class="prof-nq">Below the ' + (type === 'hit' ? '15-PA' : '5-IP') + ' minimum — shown for reference, not ranked.</div>';
    var title = type === 'hit' ? 'Plate discipline & batted-ball profile' : 'Command & contact profile';
    return '<div class="prof-wrap" id="prof-' + type + '">' +
      '<div class="prof-h"><span>' + title + '</span></div>' +
      '<div class="prof-chips">' + chips + '</div>' + banner +
      '<div class="prof-bars">' + profileHead() + buildProfileRows(type, line) + '</div>' +
      '</div>';
  }
  window.pcxProfSel = function (type, idx) {
    profileSel[type] = idx;
    var host = document.getElementById('prof-' + type);
    if (host && host.parentNode) {
      var tmp = document.createElement('div');
      tmp.innerHTML = profileSection(type);
      if (tmp.firstChild) host.parentNode.replaceChild(tmp.firstChild, host);
    }
  };

  /* ---- career trend sparklines ---- */
  // one aggregated point per SEASON (year); multiple team-lines in a year combine
  function profSeasonGroups(type) {
    var sect = type === 'hit' ? 'bat' : 'pit';
    var lines = statLines.filter(function (l) { return l[sect]; });
    return groupSeasons(lines).slice().sort(function (a, b) { return n(a.year) - n(b.year); });
  }
  function sparkSection(type) {
    var groups = profSeasonGroups(type);
    if (groups.length < 2) return '';                 // need ≥2 seasons for a trend
    var specs = type === 'hit'
      ? [{ k: 'AVG', lb: false, get: function (g) { return batAgg(g.lines).AVG; }, fmt: f3 },
         { k: 'OBP', lb: false, get: function (g) { return batAgg(g.lines).OBP; }, fmt: f3 },
         { k: 'SLG', lb: false, get: function (g) { return batAgg(g.lines).SLG; }, fmt: f3 },
         { k: 'OPS', lb: false, get: function (g) { return batAgg(g.lines).OPS; }, fmt: f3 }]
      : [{ k: 'ERA', lb: true, get: function (g) { var a = pitAgg(g.lines); return a.ip ? a.eraW / a.ip : null; }, fmt: f2 },
         { k: 'WHIP', lb: true, get: function (g) { var a = pitAgg(g.lines); return a.ip ? (a.H + a.BB) / a.ip : null; }, fmt: f2 },
         { k: 'K/9', lb: false, get: function (g) { var a = pitAgg(g.lines); return a.ip ? a.SO * 9 / a.ip : null; }, fmt: f1 },
         { k: 'BB/9', lb: true, get: function (g) { var a = pitAgg(g.lines); return a.ip ? a.BB * 9 / a.ip : null; }, fmt: f1 }];
    var cells = specs.map(function (s) { return sparkCell(s, groups); }).join('');
    if (!cells) return '';
    return '<div class="prof-wrap"><div class="prof-h"><span>Career trend</span><span class="prof-meta">by season · multi-team years combined</span></div>' +
      '<div class="spark-grid">' + cells + '</div></div>';
  }
  function sparkCell(s, groups) {
    var W = 120, H = 34, PAD = 4;
    var vals = groups.map(s.get);
    var fin = vals.filter(function (v) { return v != null && isFinite(v); });
    if (fin.length < 2) return '';
    var min = Math.min.apply(null, fin), max = Math.max.apply(null, fin), rng = (max - min) || 1;
    var pts = vals.map(function (v, i) {
      var x = PAD + i * (W - 2 * PAD) / (vals.length - 1);
      var y = (v == null || !isFinite(v)) ? null : (H - PAD - ((v - min) / rng) * (H - 2 * PAD));
      return [x, y];
    }).filter(function (p) { return p[1] != null; });
    var line = pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    var area = 'M' + pts[0][0].toFixed(1) + ',' + (H - PAD) + ' L' + line.split(' ').join(' L') + ' L' + pts[pts.length - 1][0].toFixed(1) + ',' + (H - PAD) + ' Z';
    var last = pts[pts.length - 1], first = fin[0], lastV = fin[fin.length - 1], delta = lastV - first;
    var improved = s.lb ? (delta < 0) : (delta > 0);
    var stroke = improved ? '#00c964' : '#e8624a';
    var fill = improved ? 'rgba(0,201,100,0.14)' : 'rgba(232,98,74,0.12)';
    var dtxt = (delta >= 0 ? '+' : '\u2212') + s.fmt(Math.abs(delta));
    return '<div class="spark"><div class="sk">' + s.k + '</div>' +
      '<div class="sv">' + s.fmt(lastV) + '<span class="dlt ' + (improved ? 'up' : 'down') + '">' + dtxt + '</span></div>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      '<path d="' + area + '" fill="' + fill + '"/>' +
      '<polyline points="' + line + '" fill="none" stroke="' + stroke + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="3" fill="' + stroke + '"/>' +
      '</svg></div>';
  }

  /* ---- fielding position heat tiles ---- */
  function posHeat(t) { return 'rgb(' + Math.round(26 + t * (0 - 26)) + ',' + Math.round(64 + t * (180 - 64)) + ',' + Math.round(110 + t * (95 - 110)) + ')'; }
  function posMeta(agg) {
    var pos = agg.pos || {}, total = 0, k;
    for (k in pos) total += pos[k];
    var nPos = Object.keys(pos).filter(function (x) { return pos[x] > 0; }).length;
    var primary = posList(pos)[0] || '—';
    return '<span class="prof-meta"><b>' + nPos + '</b> pos · <b>' + primary + '</b> primary · <b>' + Math.round(total) + '</b> inn</span>';
  }
  function posTileCells(agg) {
    var ORDER = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];
    var pos = agg.pos || {}, total = 0, k;
    for (k in pos) total += pos[k];
    if (!total) return '';
    var maxSh = 0; ORDER.forEach(function (p) { if (pos[p]) maxSh = Math.max(maxSh, pos[p] / total); });
    return ORDER.map(function (p) {
      var inn = pos[p] || 0;
      if (!inn) return '<div class="ptile off"><div class="ptp">' + p + '</div><div class="pti">—</div></div>';
      var sh = inn / total, t = maxSh ? sh / maxSh : 0, bord = t > 0.85 ? '#00c964' : '#2a5286';
      return '<div class="ptile" style="background:' + posHeat(t) + ';border-color:' + bord + '">' +
        '<div class="ptp">' + p + '</div><div class="pts">' + Math.round(sh * 100) + '%</div><div class="pti">' + Math.round(inn) + ' inn</div></div>';
    }).join('');
  }
  function posTiles(agg) {
    var pos = agg.pos || {}, total = 0, k;
    for (k in pos) total += pos[k];
    if (!total) return '';
    return '<div class="prof-wrap"><div class="prof-h"><span>Positions played</span>' + posMeta(agg) + '</div>' +
      '<div class="ptiles">' + posTileCells(agg) + '</div></div>';
  }

  /* season-filterable variant — chips default to Career (all seasons pooled) */
  var posSel = null;  // null = Career; otherwise an index into the fielding lines
  function posTilesSection(lines) {
    var sel = posSel;
    if (sel != null && (sel < 0 || sel >= lines.length)) sel = null;
    var agg = (sel == null) ? fldAgg(lines) : fldAgg([lines[sel]]);
    var hasInn = false, pk; for (pk in (agg.pos || {})) if (agg.pos[pk] > 0) hasInn = true;
    var chips = '<button class="prof-chip' + (sel == null ? ' on' : '') + '" onclick="pcxPosSel(-1)">Career</button>' +
      lines.map(function (l, i) {
        return '<button class="prof-chip' + (i === sel ? ' on' : '') + '" onclick="pcxPosSel(' + i + ')">' +
          yearLabel(l) + ' ' + (l.levelKey || '') + '</button>';
      }).join('');
    var body = hasInn ? posTileCells(agg)
      : '<div class="pcx-empty" style="padding:6px 4px">No fielding innings recorded for this season.</div>';
    return '<div class="prof-wrap" id="postiles-wrap"><div class="prof-h"><span>Positions played</span>' + posMeta(agg) + '</div>' +
      '<div class="prof-chips">' + chips + '</div>' +
      '<div class="ptiles">' + body + '</div></div>';
  }
  window.pcxPosSel = function (idx) {
    posSel = (idx < 0) ? null : idx;
    var host = document.getElementById('postiles-wrap');
    if (!host || !host.parentNode) return;
    var lines = statLines.filter(function (l) { return l.fld; });
    var tmp = document.createElement('div');
    tmp.innerHTML = posTilesSection(lines);
    if (tmp.firstChild) host.parentNode.replaceChild(tmp.firstChild, host);
  };

  /* ---- HITTING ---- */
  function batAgg(list) {
    var a = { GP: 0, PA: 0, AB: 0, R: 0, H: 0, _2B: 0, _3B: 0, HR: 0, RBI: 0, BB: 0, SO: 0, HBP: 0, SF: 0, SB: 0, TB: 0 };
    list.forEach(function (l) { var b = l.bat; if (!b) return; for (var k in a) a[k] += n(b[k]); });
    a.AVG = a.AB ? a.H / a.AB : 0;
    a.OBP = (a.AB + a.BB + a.HBP + a.SF) ? (a.H + a.BB + a.HBP) / (a.AB + a.BB + a.HBP + a.SF) : 0;
    a.SLG = a.AB ? a.TB / a.AB : 0;
    a.OPS = a.OBP + a.SLG;
    return a;
  }
  function renderHitting() {
    var lines = statLines.filter(function (l) { return l.bat; });
    if (!lines.length) { var bp = skillBPSection(); return bp ? (emptyTab('No game hitting stats imported yet.') + bp) : emptyTab('No hitting stats imported for this player yet.'); }
    var mode = pcMode === 'trad' ? 'trad' : 'adv';
    var statCols = HUBCOLS.hit[mode];
    var cols = ['Year', 'Lvl'].concat(statCols);
    var colored = colorizeVsPop(statCols, lines, 'hit', mode);
    var rows = [];
    groupSeasons(lines).forEach(function (g) {
      if (g.lines.length > 1) rows.push(seasonTotRow(g, statCols, hitTotals(g.lines, mode), 'hit'));
      g.lines.forEach(function (l, j) { rows.push({ d: [yearLabel(l), lvlBadge(l.levelKey)].concat(colored[g.idx[j]]) }); });
    });
    rows.push({ cls: 'career', d: ['Career', ''].concat(boxStatCells(statCols, hitTotals(lines, mode), 'hit')) });
    var splits = buildSplits(lines, 'hit', statCols, function (g) { return hitTotals(g, mode); }, mode === 'trad' ? ['AVG', 'OPS'] : ['K%', 'BB%', 'OPS']);
    return tbl(cols, rows, 2, mode === 'trad' ? ['AVG', 'OPS'] : ['K%', 'BB%', 'OPS']) + splits + profileSection('hit') + sparkSection('hit') + skillBPSection() + levelLegend();
  }

  /* ---- PITCHING (game) ---- */
  function pitAgg(list) {
    var a = { GP: 0, GS: 0, outs: 0, BF: 0, W: 0, L: 0, SV: 0, H: 0, R: 0, ER: 0, BB: 0, SO: 0, HR: 0, eraW: 0, fipW: 0 };
    list.forEach(function (l) {
      var p = l.pit; if (!p) return;
      var ip = ipDec(p.IP);
      a.outs += Math.round(ip * 3); a.GP += n(p.GP); a.GS += n(p.GS); a.BF += n(p.BF); a.W += n(p.W); a.L += n(p.L); a.SV += n(p.SV); a.H += n(p.H); a.R += n(p.R); a.ER += n(p.ER); a.BB += n(p.BB); a.SO += n(p.SO); a.HR += n(p.HR);
      // ERA/FIP are kept as IP-weighted means of GameChanger's own values so the
      // career line honors whatever game length (7-inning HS, 9-inning Legion) GC used.
      if (p.ERA != null) a.eraW += n(p.ERA) * ip;
      if (p.FIP != null) a.fipW += n(p.FIP) * ip;
    });
    a.ip = a.outs / 3;
    return a;
  }
  function renderPitchingGame() {
    var lines = statLines.filter(function (l) { return l.pit; });
    if (!lines.length) return ''; // bullpen fold still shows below
    var mode = pcMode === 'trad' ? 'trad' : 'adv';
    var statCols = HUBCOLS.pit[mode];
    var cols = ['Year', 'Lvl'].concat(statCols);
    var colored = colorizeVsPop(statCols, lines, 'pit', mode);
    var rows = [];
    groupSeasons(lines).forEach(function (g) {
      if (g.lines.length > 1) rows.push(seasonTotRow(g, statCols, pitTotals(g.lines, mode), 'pit'));
      g.lines.forEach(function (l, j) { rows.push({ d: [yearLabel(l), lvlBadge(l.levelKey)].concat(colored[g.idx[j]]) }); });
    });
    rows.push({ cls: 'career', d: ['Career', ''].concat(boxStatCells(statCols, pitTotals(lines, mode), 'pit')) });
    var splits = buildSplits(lines, 'pit', statCols, function (g) { return pitTotals(g, mode); }, mode === 'trad' ? ['ERA', 'WHIP'] : ['K%', 'FIP', 'WHIP']);
    return tbl(cols, rows, 2, mode === 'trad' ? ['ERA', 'WHIP'] : ['K%', 'FIP', 'WHIP']) + splits;
  }

  /* ---- bullpen fold (reuses app.js section builders) ---- */
  function renderBullpenFold() {
    var d = playerCardData || { seasons: [] };
    var seasons = d.seasons || [];
    if (!seasons.length) return '';
    var head = '<div class="pen-divider"><span>🎯 Bullpen Development</span><span class="pen-divsub">from the Lakers Bullpen tracker</span></div>';
    var body = '';
    try {
      body = sectionSeasonTable(seasons) + sectionTrends(seasons) + sectionCommand(d) + sectionManage();
    } catch (e) { body = '<div class="pcx-empty">Bullpen sections unavailable.</div>'; }
    return head + body;
  }

  /* ---- FIELDING ---- */
  function fldAgg(list) {
    var a = { TC: 0, PO: 0, A: 0, E: 0, DP: 0, PB: 0, csSB: 0, CS: 0, PIK: 0, pos: {} };
    list.forEach(function (l) {
      var f = l.fld; if (!f) return;
      a.TC += n(f.TC); a.PO += n(f.PO); a.A += n(f.A); a.E += n(f.E); a.DP += n(f.DP);
      a.PB += n(f.PB); a.csSB += n(f.SB); a.CS += n(f.CS); a.PIK += n(f.PIK);
      if (f.pos) for (var k in f.pos) a.pos[k] = (a.pos[k] || 0) + n(f.pos[k]);
    });
    a.FPCT = (a.TC) ? f3((a.PO + a.A) / a.TC) : '—';
    return a;
  }
  function fldAggCells(a) { return [posList(a.pos || {}).slice(0, 3).join('·') || '—', a.TC, a.PO, a.A, a.E, a.DP, a.FPCT]; }
  function posList(pos) {
    return Object.keys(pos).sort(function (x, y) { return pos[y] - pos[x]; });
  }
  function renderFielding() {
    var lines = statLines.filter(function (l) { return l.fld; });
    if (!lines.length) { var sk = skillFieldSection(); return sk ? (emptyTab('No game fielding stats imported yet.') + sk) : emptyTab('No fielding stats imported for this player yet.'); }
    posSel = null;  // default to Career each time the fielding tab is rendered

    var cols = ['Year', 'Lvl', 'Pos', 'TC', 'PO', 'A', 'E', 'DP', 'FPCT'];
    var fStatCols = ['Pos', 'TC', 'PO', 'A', 'E', 'DP', 'FPCT'];
    var fColored = lines.map(function (l) {
      var f = l.fld, raw = [posList(f.pos || {}).slice(0, 3).join('·') || '—', f.TC, f.PO, f.A, f.E, f.DP, dash(f.FPCT)];
      var ranges = popRanges(l.year, 'fld', 'trad');
      return raw.map(function (v, ci) { var k = fStatCols[ci]; return isRate('fld', k) ? pill(v, ranges[k] ? relColor(v, k, 'fld', ranges[k]) : '') : v; });
    });
    var rows = [];
    groupSeasons(lines).forEach(function (g) {
      if (g.lines.length > 1) rows.push(seasonTotRow(g, fStatCols, fldAggCells(fldAgg(g.lines)), 'fld'));
      g.lines.forEach(function (l, j) { rows.push({ d: [yearLabel(l), lvlBadge(l.levelKey)].concat(fColored[g.idx[j]]) }); });
    });
    var c = fldAgg(lines);
    rows.push({ cls: 'career', d: ['Career', ''].concat(boxStatCells(fStatCols, fldAggCells(c), 'fld')) });
    var splits = buildSplits(lines, 'fld', fStatCols, function (g) { return fldAggCells(fldAgg(g)); }, ['FPCT'], 3);
    var posPanel = (lines.length >= 2) ? posTilesSection(lines) : posTiles(c);
    return tbl(cols, rows, 3, ['FPCT']) + splits + posPanel + catcherPanel(c) + skillFieldSection() + levelLegend();
  }
  function catcherPanel(agg) {
    if (!(agg.pos && agg.pos.C) && !agg.PB && !agg.CS) return '';
    var denom = (agg.CS || 0) + (agg.csSB || 0);
    var csp = denom ? Math.round((agg.CS || 0) / denom * 100) + '%' : '—';
    return '<div class="pcx-catch"><div class="pcx-catch-h">Behind the plate</div><div class="pcx-catch-row">' +
      '<div class="mini"><span class="v">' + (agg.PB || 0) + '</span><span class="k">PB</span></div>' +
      '<div class="mini"><span class="v">' + (agg.CS || 0) + '</span><span class="k">CS</span></div>' +
      '<div class="mini"><span class="v">' + (agg.csSB || 0) + '</span><span class="k">SB allowed</span></div>' +
      '<div class="mini"><span class="v">' + csp + '</span><span class="k">CS%</span></div>' +
      '<div class="mini"><span class="v">' + (agg.PIK || 0) + '</span><span class="k">Pickoffs</span></div>' +
      '</div></div>';
  }

  function emptyTab(msg) { return '<div class="pcx-empty"><div class="pcx-empty-ic">📭</div><div>' + msg + '</div></div>'; }

  /* ── v28: BP / pop / sprint sections on the card ──
     Data comes from window.playerCardSkills (all this player's skill sessions,
     fetched in app.js openPlayerCard). Best & average shown side by side. */
  function sk_res(s) { return (s && typeof s === 'object') ? s.r : s; }
  function sk_velo(s) { return (s && typeof s === 'object') ? s.v : null; }
  function sk_fmtMD(iso) { if (!iso) return ''; var p = String(iso).split('-'); return ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+p[1]] + ' ' + (+p[2]); }
  function sk_sessions(kind) {
    var all = window.playerCardSkills || [];
    return all.filter(function (s) { return s.kind === kind; }).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  }
  // sparkline-ish bar row where the shortest (best) time / highest value is flagged green
  function sk_trend(vals, lowerBetter) {
    if (!vals.length) return '';
    var best = lowerBetter ? Math.min.apply(null, vals) : Math.max.apply(null, vals);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), span = (hi - lo) || 1;
    // oldest→newest left→right; vals arrive newest-first so reverse
    var seq = vals.slice().reverse();
    return '<div class="sk-trend">' + seq.map(function (v) {
      var h = lowerBetter ? (hi - v) / span : (v - lo) / span; // taller = better
      var pct = 22 + Math.round(h * 78);
      return '<div class="b' + (v === best ? ' best' : '') + '" style="height:' + pct + '%"></div>';
    }).join('') + '</div>';
  }

  window.skillBPSection = function () {
    var sess = sk_sessions('bp');
    if (!sess.length) return '';
    var perSession = sess.map(function (s) {
      var sw = (s.data.rounds || []).flatMap(function (r) { return r.swings || []; });
      var res = sw.map(sk_res); var h = res.filter(function (x) { return x === 'H'; }).length;
      var velos = sw.map(sk_velo).filter(function (v) { return v != null; });
      return { date: s.date, swings: sw.length, hardPct: sw.length ? Math.round(h / sw.length * 100) : 0,
        topEV: velos.length ? Math.max.apply(null, velos) : null };
    });
    var allSw = sess.flatMap(function (s) { return (s.data.rounds || []).flatMap(function (r) { return r.swings || []; }); });
    var res = allSw.map(sk_res); var h = res.filter(function (x) { return x === 'H'; }).length;
    var w = res.filter(function (x) { return x === 'W'; }).length, m = res.filter(function (x) { return x === 'M'; }).length;
    var velos = allSw.map(sk_velo).filter(function (v) { return v != null; });
    var bestHard = Math.max.apply(null, perSession.map(function (p) { return p.hardPct; }));
    var rows = perSession.slice(0, 6).map(function (p) {
      return '<div class="sk-row"><span class="d">' + sk_fmtMD(p.date) + '</span>' +
        '<span class="v"><span class="pill g">' + p.hardPct + '% H</span></span>' +
        '<span class="tag">' + p.swings + ' sw' + (p.topEV != null ? ' · ' + p.topEV.toFixed(1) + ' EV' : '') + (p.hardPct === bestHard ? ' · best' : '') + '</span></div>';
    }).join('');
    return '<div class="sk-section">' +
      '<div class="sk-head"><span class="l">🏏 Batting Practice</span>' +
      '<span class="pr"><div class="best"><b>' + Math.round(h / allSw.length * 100) + '%</b><span>hard</span></div>' +
      '<div><b>' + allSw.length + '</b><span>swings</span></div>' +
      (velos.length ? '<div><b>' + Math.max.apply(null, velos).toFixed(1) + '</b><span>top EV</span></div>' : '') + '</span></div>' +
      sk_trend(perSession.map(function (p) { return p.hardPct; }), false) +
      '<div class="sk-rows">' + rows + '</div>' +
      '<div class="sk-note">Practice-cage charting — not game contact. Hard/Weak/Miss + exit velo (Pocket Radar) from the Bullpen tab.</div></div>';
  };

  window.skillFieldSection = function () {
    var out = '';
    // Pop times
    var pop = sk_sessions('pop');
    if (pop.length) {
      var per = pop.map(function (s) {
        var t = (s.data.throws || []).map(function (x) { return x.t; });
        var marked = (s.data.throws || []).filter(function (x) { return x.ok !== null; });
        var on = (s.data.throws || []).filter(function (x) { return x.ok === true; }).length;
        return { date: s.date, best: t.length ? Math.min.apply(null, t) : null, n: t.length, onTgt: marked.length ? Math.round(on / marked.length * 100) : null };
      }).filter(function (p) { return p.best != null; });
      var allT = pop.flatMap(function (s) { return (s.data.throws || []).map(function (x) { return x.t; }); });
      var best = Math.min.apply(null, allT);
      var rows = per.slice(0, 6).map(function (p) {
        return '<div class="sk-row"><span class="d">' + sk_fmtMD(p.date) + '</span><span class="v' + (p.best === best ? ' best' : '') + '">' + p.best.toFixed(2) + '</span><span class="tag">' + p.n + ' thr' + (p.onTgt != null ? ' · ' + p.onTgt + '% on-tgt' : '') + (p.best === best ? ' · best' : '') + '</span></div>';
      }).join('');
      out += '<div class="sk-section"><div class="sk-head"><span class="l">🧤 Pop Times → 2B</span>' +
        '<span class="pr"><div class="best"><b>' + best.toFixed(2) + '</b><span>best</span></div><div><b>' + (allT.reduce(function (a, b) { return a + b; }, 0) / allT.length).toFixed(2) + '</b><span>avg</span></div></span></div>' +
        sk_trend(per.map(function (p) { return p.best; }), true) + '<div class="sk-rows">' + rows + '</div></div>';
    }
    // Sprints
    var spr = sk_sessions('sprint');
    if (spr.length) {
      var perS = spr.map(function (s) {
        var arr = s.data.sprints || s.data.runs || [];
        var t = arr.map(function (x) { return x.t; });
        return { date: s.date, best: t.length ? Math.min.apply(null, t) : null, n: t.length };
      }).filter(function (p) { return p.best != null; });
      var allS = spr.flatMap(function (s) { return (s.data.sprints || s.data.runs || []).map(function (x) { return x.t; }); });
      var bestS = Math.min.apply(null, allS);
      var rowsS = perS.slice(0, 6).map(function (p) {
        return '<div class="sk-row"><span class="d">' + sk_fmtMD(p.date) + '</span><span class="v' + (p.best === bestS ? ' best' : '') + '">' + p.best.toFixed(2) + '</span><span class="tag">' + p.n + ' sprints' + (p.best === bestS ? ' · best' : '') + '</span></div>';
      }).join('');
      out += '<div class="sk-section"><div class="sk-head"><span class="l">⚡ Sprint · 90 ft</span>' +
        '<span class="pr"><div class="best"><b>' + bestS.toFixed(2) + '</b><span>best</span></div><div><b>' + (allS.reduce(function (a, b) { return a + b; }, 0) / allS.length).toFixed(2) + '</b><span>avg</span></div></span></div>' +
        sk_trend(perS.map(function (p) { return p.best; }), true) + '<div class="sk-rows">' + rowsS + '</div></div>';
    }
    return out;
  };
  function levelLegend() {
    return '<div class="pcx-legend">' +
      '<span>' + lvlBadge('V') + ' Varsity</span><span>' + lvlBadge('JV') + ' JV</span>' +
      '<span>' + lvlBadge('FR') + ' Freshman</span><span>' + lvlBadge('C') + ' C-Team</span>' +
      '<span>' + lvlBadge('L') + ' Legion</span><span>' + lvlBadge('JL') + ' Jr Legion</span></div>';
  }

  /* ===================== SCOUTING REPORT (PDF) ===================== */
  function _rptLoad(src) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = function () { res(); }; s.onerror = function () { rej(new Error('Failed to load PDF library')); }; document.head.appendChild(s); }); }
  function _rptLibs() {
    var p = Promise.resolve();
    if (!(window.jspdf && window.jspdf.jsPDF)) p = p.then(function () { return _rptLoad('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js'); });
    return p.then(function () { if (!(window.jspdf.jsPDF.API && window.jspdf.jsPDF.API.autoTable)) return _rptLoad('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js'); });
  }
  function _lc(a, b, t) { return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]; }
  function _pctRGB(p) { var t = p / 100, B = [63, 127, 214], G = [138, 151, 166], R = [224, 49, 75]; return t <= 0.5 ? _lc(B, G, t / 0.5) : _lc(G, R, (t - 0.5) / 0.5); }
  function _today() { var d = new Date(), m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; return m[d.getMonth()] + ' ' + d.getDate() + ' ' + d.getFullYear(); }
  function _lvlShort(k) { return LVLSHORT[k] || k || ''; }
  function _recentLines(sect) { var ls = statLines.filter(function (l) { return l[sect]; }); if (!ls.length) return []; var my = Math.max.apply(null, ls.map(function (l) { return n(l.year); })); return ls.filter(function (l) { return n(l.year) === my; }); }
  function _seasonTag(l) { return yearLabel(l) + ' ' + _lvlShort(l.levelKey); }
  function _seasonLvl(g) { var lv = []; g.lines.forEach(function (l) { if (l.levelKey && lv.indexOf(l.levelKey) === -1) lv.push(l.levelKey); }); return g.lines.length + ' Tm ' + lv.map(_lvlShort).join('·'); }
  function _profData(type) {
    var ls = profSeasonLines(type); if (!ls.length) return null;
    var line = null, i; for (i = ls.length - 1; i >= 0; i--) { if (qualifies(ls[i], type)) { line = ls[i]; break; } }
    if (!line) line = ls[ls.length - 1];
    var spec = type === 'hit' ? HITPROF : PITPROF, pool = profilePool(type, tierOf(line.levelKey)), graded = qualifies(line, type);
    return { line: line, rows: spec.map(function (s) { var v = s.get(line); var disp = (v == null || !isFinite(v)) ? '—' : s.fmt(v); var pct = graded ? pctRank(v, pool.map(s.get), s.dir) : null; return { k: s.k, disp: disp, pct: pct }; }) };
  }
  function _seasonRows(sect, fn) {
    var ls = statLines.filter(function (l) { return l[sect]; }); if (!ls.length) return null;
    var body = [], types = [];
    groupSeasons(ls).forEach(function (g) {
      if (g.lines.length > 1) { body.push([g.year, _seasonLvl(g)].concat(fn(g.lines))); types.push('sub'); }
      g.lines.forEach(function (l) { body.push([yearLabel(l), _lvlShort(l.levelKey)].concat(fn([l]))); types.push(''); });
    });
    body.push(['Career', ''].concat(fn(ls))); types.push('tot');
    return { body: body, types: types, lines: ls };
  }
  // KDE density (same colormap/algorithm as the card; white bg, navy strike zone)
  var _DST = [[0, [51, 77, 191], 0], [.18, [51, 140, 242], .55], [.42, [77, 204, 204], .9], [.6, [242, 230, 77], .92], [.8, [247, 140, 51], .94], [1, [217, 31, 36], .96]];
  function _dRGBA(t) { if (t <= 0) return [0, 0, 0, 0]; if (t >= 1) { var L = _DST[_DST.length - 1]; return [L[1][0], L[1][1], L[1][2], L[2]]; } for (var i = 1; i < _DST.length; i++) { if (t <= _DST[i][0]) { var a = _DST[i - 1], b = _DST[i], f = (t - a[0]) / ((b[0] - a[0]) || 1); return [Math.round(a[1][0] + (b[1][0] - a[1][0]) * f), Math.round(a[1][1] + (b[1][1] - a[1][1]) * f), Math.round(a[1][2] + (b[1][2] - a[1][2]) * f), a[2] + (b[2] - a[2]) * f]; } } var L = _DST[_DST.length - 1]; return [L[1][0], L[1][1], L[1][2], L[2]]; }
  function _dGrid(points, GW, GH, sigma) { var g = new Float32Array(GW * GH), i, x, y; points.forEach(function (p) { var gx = Math.min(GW - 1, Math.max(0, Math.round((p.col + .5) / 20 * GW - .5))), gy = Math.min(GH - 1, Math.max(0, Math.round((p.row + .5) / 20 * GH - .5))); g[gy * GW + gx] += 1; }); var rad = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(rad * 2 + 1), ks = 0; for (i = -rad; i <= rad; i++) { var v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + rad] = v; ks += v; } for (i = 0; i < k.length; i++) k[i] /= ks; var tmp = new Float32Array(GW * GH); for (y = 0; y < GH; y++) for (x = 0; x < GW; x++) { var s = 0; for (i = -rad; i <= rad; i++) { var xx = Math.min(GW - 1, Math.max(0, x + i)); s += g[y * GW + xx] * k[i + rad]; } tmp[y * GW + x] = s; } for (y = 0; y < GH; y++) for (x = 0; x < GW; x++) { var s2 = 0; for (i = -rad; i <= rad; i++) { var yy = Math.min(GH - 1, Math.max(0, y + i)); s2 += tmp[yy * GW + x] * k[i + rad]; } g[y * GW + x] = s2; } var mx = 0; for (i = 0; i < g.length; i++) if (g[i] > mx) mx = g[i]; if (mx > 0) for (i = 0; i < g.length; i++) g[i] /= mx; return g; }
  function _heatCanvas(points) {
    var sc = 3, W = 120, H = 132, cv = document.createElement('canvas'); cv.width = W * sc; cv.height = H * sc;
    var ctx = cv.getContext('2d'); ctx.scale(sc, sc); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    if (points && points.length) {
      var GW = 54, GH = 60, sig = GW * 0.075, grid = _dGrid(points, GW, GH, sig);
      var off = document.createElement('canvas'); off.width = GW; off.height = GH; var oc = off.getContext('2d'); var img = oc.createImageData(GW, GH);
      for (var i = 0; i < grid.length; i++) { var c = _dRGBA(grid[i]); img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = Math.round(c[3] * 255); }
      oc.putImageData(img, 0, 0); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(off, 0, 0, GW, GH, 0, 0, W, H);
    }
    var zx = W * .2, zy = H * .2, zw = W * .6, zh = H * .6, j;
    ctx.strokeStyle = 'rgba(16,77,151,.85)'; ctx.lineWidth = 1.4; ctx.setLineDash([5, 4]); ctx.strokeRect(zx, zy, zw, zh); ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(16,77,151,.22)'; ctx.lineWidth = .7; for (j = 1; j < 3; j++) { ctx.beginPath(); ctx.moveTo(zx + zw * j / 3, zy); ctx.lineTo(zx + zw * j / 3, zy + zh); ctx.stroke(); ctx.beginPath(); ctx.moveTo(zx, zy + zh * j / 3); ctx.lineTo(zx + zw, zy + zh * j / 3); ctx.stroke(); }
    var px = W / 2, py = H - 7, pw = Math.max(8, W * .07); ctx.beginPath(); ctx.moveTo(px - pw, py - pw * .62); ctx.lineTo(px + pw, py - pw * .62); ctx.lineTo(px + pw, py); ctx.lineTo(px, py + pw * .62); ctx.lineTo(px - pw, py); ctx.closePath(); ctx.fillStyle = 'rgba(16,77,151,.05)'; ctx.fill(); ctx.strokeStyle = 'rgba(16,77,151,.3)'; ctx.lineWidth = 1; ctx.stroke();
    return cv;
  }

  window.pcxShareReport = async function (btn) {
    var orig;
    try {
      if (!statLines || !statLines.length) { if (window.showToast) showToast('No imported stats to build a report'); return; }
      if (btn) { orig = btn.textContent; btn.disabled = true; btn.textContent = 'Generating…'; }
      await _rptLibs();
      var jsPDF = window.jspdf.jsPDF;
      var doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
      var PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight(), M = 34, CW = PW - M * 2, y = 0;
      var nameEl = document.getElementById('playerCardName');
      var name = (nameEl && nameEl.textContent && nameEl.textContent.trim()) || 'Player';
      var number = ''; for (var bi = 0; bi < statLines.length; bi++) { if (statLines[bi].number) { number = statLines[bi].number; break; } }
      var maxY = Math.max.apply(null, statLines.map(function (l) { return n(l.year); }));
      var recentLvls = [], allLvls = [];
      statLines.forEach(function (l) { if (l.levelKey && allLvls.indexOf(l.levelKey) === -1) allLvls.push(l.levelKey); if (n(l.year) === maxY && l.levelKey && recentLvls.indexOf(l.levelKey) === -1) recentLvls.push(l.levelKey); });
      var fAll = statLines.filter(function (l) { return l.fld; });
      var primaryPos = fAll.length ? (posList(fldAgg(fAll).pos)[0] || '') : '';

      function ensure(h) { if (y + h > PH - 28) { doc.addPage(); y = 34; } }
      function _leftCols(nL) { var o = {}; for (var i = 0; i < nL; i++) o[i] = { halign: 'left' }; return o; }
      function table(head, data, left) {
        doc.autoTable({
          startY: y, head: [head], body: data.body, margin: { left: M, right: M }, theme: 'grid',
          styles: { font: 'helvetica', fontSize: 6.4, cellPadding: 2, lineColor: [223, 230, 238], lineWidth: 0.3, textColor: [26, 35, 48], halign: 'right', valign: 'middle' },
          headStyles: { fillColor: [9, 43, 73], textColor: [255, 255, 255], fontSize: 5.6, fontStyle: 'bold', halign: 'right' },
          columnStyles: _leftCols(left),
          didParseCell: function (dd) { if (dd.section === 'body') { var rt = data.types[dd.row.index]; if (rt === 'tot') { dd.cell.styles.fillColor = [234, 242, 255]; dd.cell.styles.textColor = [9, 43, 73]; dd.cell.styles.fontStyle = 'bold'; } else if (rt === 'sub') { dd.cell.styles.fillColor = [238, 247, 240]; dd.cell.styles.textColor = [10, 94, 52]; dd.cell.styles.fontStyle = 'bold'; } } }
        });
        y = doc.lastAutoTable.finalY;
      }
      function sectionH(txt) { ensure(28); doc.setTextColor(9, 43, 73); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(txt, M, y + 12); doc.setDrawColor(2, 131, 66); doc.setLineWidth(1.4); doc.line(M, y + 16, PW - M, y + 16); doc.setLineWidth(0.3); y += 22; }
      function drawPctRow(x, ry, w, r) {
        var labW = 48, valW = 34, barX = x + labW + 6, barW = w - labW - valW - 12, cy = ry + 8;
        doc.setTextColor(40, 48, 60); doc.setFont('helvetica', 'bold'); doc.setFontSize(6.6); doc.text(r.k, x + labW, cy + 2, { align: 'right' });
        doc.setFillColor(233, 238, 244); doc.roundedRect(barX, cy - 3, barW, 6, 3, 3, 'F');
        if (r.pct != null) {
          var col = _pctRGB(r.pct); doc.setFillColor(col[0], col[1], col[2]); doc.roundedRect(barX, cy - 3, Math.max(4, barW * r.pct / 100), 6, 3, 3, 'F');
          var bx = barX + Math.max(8, Math.min(barW - 8, barW * r.pct / 100)); doc.setFillColor(col[0], col[1], col[2]); doc.circle(bx, cy, 6, 'F');
          doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(6); doc.text(String(r.pct), bx, cy + 2, { align: 'center' });
        }
        doc.setTextColor(40, 48, 60); doc.setFont('helvetica', 'bold'); doc.setFontSize(6.4); doc.text(String(r.disp), x + w, cy + 2, { align: 'right' });
      }
      function pctBlock(sub2, rows) {
        ensure(24); doc.setTextColor(107, 119, 133); doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5);
        doc.text('PERCENTILES VS UPPER TIER', M, y + 8); doc.text(sub2, PW - M, y + 8, { align: 'right' }); y += 14;
        var half = Math.ceil(rows.length / 2), colW = (CW - 26) / 2, rh = 15;
        ensure(half * rh + 6);
        for (var i = 0; i < half; i++) { drawPctRow(M, y + i * rh, colW, rows[i]); if (rows[i + half]) drawPctRow(M + colW + 26, y + i * rh, colW, rows[i + half]); }
        y += half * rh + 8;
      }
      function bullpenBlock() {
        var bp = (typeof window.pcxBullpenReport === 'function') ? window.pcxBullpenReport() : null;
        if (!bp || !bp.types.some(function (t) { return t.points.length; })) return;
        ensure(170);
        doc.setTextColor(107, 119, 133); doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5);
        doc.text("BULLPEN COMMAND · PITCH LOCATION (PITCHER'S VIEW)", M, y + 8); doc.text(bp.season + ' · ' + bp.totalPitches + ' pitches', PW - M, y + 8, { align: 'right' }); y += 14;
        var mapW = (CW - 32) / 3, mapH = mapW * 132 / 120;
        bp.types.forEach(function (t, idx) {
          var cx = M + idx * (mapW + 16);
          doc.setTextColor(t.rgb[0], t.rgb[1], t.rgb[2]); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.4); doc.text(t.label, cx, y + 8);
          doc.setTextColor(107, 119, 133); doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.text((t.n ? t.n + 'p' : '—') + (t.execPct != null ? ' · ' + t.execPct + '%' : ''), cx + mapW, y + 8, { align: 'right' });
          doc.addImage(_heatCanvas(t.points), 'PNG', cx, y + 12, mapW, mapH); doc.setDrawColor(223, 230, 238); doc.rect(cx, y + 12, mapW, mapH);
        });
        y += 12 + mapH + 4;
        doc.setTextColor(107, 119, 133); doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.text('fewer \u2192 more pitches · dashed box = strike zone', PW / 2, y + 4, { align: 'center' }); y += 12;
        var items = [['All', bp.execAll, [2, 131, 66]]]; bp.types.forEach(function (t) { items.push([t.label, t.execPct, t.rgb]); });
        var ew = (CW - 36) / 4;
        items.forEach(function (e, idx) { if (e[1] == null) return; var ex = M + idx * (ew + 12); doc.setTextColor(e[2][0], e[2][1], e[2][2]); doc.setFont('helvetica', 'bold'); doc.setFontSize(6.4); doc.text(e[0] + ' exec', ex, y + 6); doc.setFillColor(233, 238, 244); doc.roundedRect(ex, y + 9, ew, 6, 3, 3, 'F'); doc.setFillColor(e[2][0], e[2][1], e[2][2]); doc.roundedRect(ex, y + 9, Math.max(4, ew * e[1] / 100), 6, 3, 3, 'F'); doc.setTextColor(60, 68, 80); doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.text(e[1] + '%', ex + ew, y + 6, { align: 'right' }); });
        y += 22;
        var vp = []; bp.types.forEach(function (t) { if (t.velo) vp.push(t.label.slice(0, 2) + ' ' + t.velo); });
        if (vp.length) { doc.setTextColor(107, 119, 133); doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.text('Avg velo:   ' + vp.join('    '), M, y + 4); y += 10; }
      }
      function posBlock() {
        var f = statLines.filter(function (l) { return l.fld; }); if (!f.length) return;
        var pos = fldAgg(f).pos || {}, tot = 0, k; for (k in pos) tot += pos[k]; if (!tot) return;
        var order = posList(pos); ensure(44);
        doc.setTextColor(107, 119, 133); doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.text('POSITIONS PLAYED', M, y + 8); y += 12;
        var tw = 60, th = 26, gap = 8, tx = M;
        order.forEach(function (p, idx) {
          if (tx + tw > PW - M) { tx = M; y += th + gap; }
          var sh = Math.round(pos[p] / tot * 100), inn = Math.round(pos[p]), on = idx === 0;
          if (on) doc.setFillColor(16, 77, 151); else doc.setFillColor(251, 252, 254);
          doc.setDrawColor(219, 226, 234); doc.roundedRect(tx, y, tw, th, 4, 4, on ? 'F' : 'FD');
          doc.setTextColor(on ? 255 : 9, on ? 255 : 43, on ? 255 : 73); doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.text(p, tx + tw / 2, y + 11, { align: 'center' });
          doc.setTextColor(on ? 207 : 107, on ? 224 : 119, on ? 245 : 133); doc.setFont('helvetica', 'normal'); doc.setFontSize(5.6); doc.text(sh + '% · ' + inn, tx + tw / 2, y + 20, { align: 'center' });
          tx += tw + gap;
        });
        y += th + 6;
      }

      // ---- header band ----
      doc.setFillColor(9, 43, 73); doc.rect(0, 0, PW, 74, 'F'); doc.setFillColor(2, 131, 66); doc.rect(0, 74, PW, 3, 'F');
      doc.setTextColor(166, 195, 230); doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
      doc.text('MINNEWASKA LAKERS BASEBALL · SCOUTING REPORT', M, 20); doc.text('Generated ' + _today(), PW - M, 20, { align: 'right' });
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.text(name, M, 48);
      if (number) { var nw = doc.getTextWidth(name); doc.setFontSize(11); doc.setTextColor(200, 215, 235); doc.text('#' + number, M + nw + 10, 46); }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(220, 231, 245);
      doc.text((primaryPos ? primaryPos + ' · primary position    ' : '') + 'Appeared at ' + allLvls.map(function (k) { return TEAMLABEL[k] || k; }).join(' · '), M, 66);
      y = 77;

      // ---- snapshot (most recent season) ----
      var rH = _recentLines('bat'), rP = _recentLines('pit'), rF = _recentLines('fld'), chips = [];
      if (rH.length) { var ht = hitTotals(rH, 'trad'); chips.push(['AVG', ht[12]], ['OPS', ht[15]], ['HR', String(ht[7])]); }
      if (rP.length) { var pt = pitTotals(rP, 'trad'); chips.push(['ERA', pt[12]], ['K', String(pt[10])]); }
      if (rF.length) { var ft = fldAggCells(fldAgg(rF)); chips.push(['FPCT', ft[6]]); }
      doc.setFillColor(243, 246, 250); doc.rect(0, y, PW, 16, 'F'); doc.setTextColor(16, 77, 151); doc.setFont('helvetica', 'bold'); doc.setFontSize(7);
      doc.text('MOST RECENT SEASON — ' + maxY + ' · ' + recentLvls.map(function (k) { return TEAMLABEL[k] || k; }).join(' · '), M, y + 11); y += 16;
      var chipH = 34, cwc = CW / Math.max(1, chips.length);
      chips.forEach(function (c, idx) {
        var cx = M + idx * cwc; doc.setTextColor(16, 77, 151); doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text(String(c[1]), cx + cwc / 2, y + 16, { align: 'center' });
        doc.setTextColor(107, 119, 133); doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.text(c[0], cx + cwc / 2, y + 27, { align: 'center' });
        if (idx > 0) { doc.setDrawColor(219, 226, 234); doc.line(cx, y, cx, y + chipH); }
      });
      doc.setDrawColor(219, 226, 234); doc.line(0, y + chipH, PW, y + chipH); y += chipH + 14;

      // ---- sections ----
      var hd = _seasonRows('bat', function (ls) { return hitTotals(ls, 'trad'); });
      if (hd) { sectionH('Hitting'); table(['Yr', 'Lvl'].concat(HUBCOLS.hit.trad), hd, 2); var hp = _profData('hit'); if (hp) { y += 8; pctBlock(_seasonTag(hp.line), hp.rows); } }
      var pd = _seasonRows('pit', function (ls) { return pitTotals(ls, 'trad'); });
      if (pd) { ensure(46); y += 6; sectionH('Pitching'); table(['Yr', 'Lvl'].concat(HUBCOLS.pit.trad), pd, 2); var pp = _profData('pit'); if (pp) { y += 8; pctBlock(_seasonTag(pp.line), pp.rows); } bullpenBlock(); }
      var fd = _seasonRows('fld', function (ls) { return fldAggCells(fldAgg(ls)); });
      if (fd) { ensure(46); y += 6; sectionH('Fielding'); table(['Yr', 'Lvl', 'Pos', 'TC', 'PO', 'A', 'E', 'DP', 'FPCT'], fd, 3); posBlock(); }

      // ---- footers ----
      var np = doc.internal.getNumberOfPages();
      for (var pi = 1; pi <= np; pi++) { doc.setPage(pi); doc.setTextColor(140, 150, 160); doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.text('Lakers Bullpen · lakers-bullpen.web.app', M, PH - 16); if (np > 1) doc.text(pi + ' / ' + np, PW - M, PH - 16, { align: 'right' }); }

      // ---- share / download ----
      var blob = doc.output('blob');
      var fname = String(name).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_Scouting_Report.pdf';
      var file = new File([blob], fname, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'Scouting Report — ' + name }); return; }
        catch (err) { if (err && err.name === 'AbortError') return; }
      }
      var url = URL.createObjectURL(blob); var a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      if (window.showToast) showToast('Report downloaded');
    } catch (e) { if (window.showToast) showToast('Report failed: ' + (e && e.message || e)); }
    finally { if (btn) { btn.disabled = false; btn.textContent = orig || '⤴ Share report'; } }
  };
})();
