/* ============================================================
   GAMECHANGER STAT IMPORT  (lakers-bullpen)
   ------------------------------------------------------------
   Drag-and-drop a GameChanger "Season Stats" CSV (one file per
   team + season; batting, pitching & fielding all in one row per
   player). Parses it, tags it {year · term · level} from the
   filename, matches names to the roster, and writes one
   Baseball-Reference statline per player via the data layer's
   `import_stats` action. PIN-gated (2149) like every other write.

   Loaded AFTER app.js + firebase-data-layer.js.
   ============================================================ */
(function () {
  'use strict';

  /* ── CSV PARSING (quoted-comma safe) ─────────────────────── */
  function parseCsv(text) {
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else {
        if (c === '"') q = true;
        else if (c === ',') { row.push(cur); cur = ''; }
        else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
        else if (c === '\r') { /* skip */ }
        else cur += c;
      }
    }
    if (cur.length || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

  // GameChanger repeats column names (H, BB, SO, 1B…) across the
  // Batting / Pitching / Fielding groups. Key every column by the
  // section it falls under so the duplicates never collide.
  function buildHeaderKeys(sectionRow, headerRow) {
    var bounds = [];
    sectionRow.forEach(function (s, i) { if (s && s.trim()) bounds.push([i, s.trim().toLowerCase().slice(0, 3)]); });
    function sof(i) { var cur = 'id'; for (var b = 0; b < bounds.length; b++) { if (i >= bounds[b][0]) cur = bounds[b][1]; } return cur; }
    return headerRow.map(function (h, i) { return sof(i) + '.' + String(h).trim(); });
  }

  function num(x) { if (x == null) return null; x = String(x).trim(); if (x === '' || x === '-' || x === 'N/A') return null; var n = parseFloat(x); return isNaN(n) ? null : n; }
  function raw(x) { if (x == null) return null; x = String(x).trim(); return (x === '' || x === '-' || x === 'N/A') ? null : x; }

  /* ── FILENAME → {year, term, level} ──────────────────────── */
  var TERMS = ['Spring', 'Summer', 'Fall', 'Winter'];
  var LEVELS = [
    ['Varsity', 'Varsity', 'V'], ['Junior Varsity', 'JV', 'JV'], ['JV', 'JV', 'JV'],
    ['Freshman', 'Freshman', 'FR'],
    ['Jr[ _-]?Legion', 'Jr Legion', 'JL'],
    ['Junior Legion', 'Jr Legion', 'JL'], ['Legion', 'Legion', 'L']
  ];
  function parseStatFilename(name) {
    var base = String(name).replace(/\.csv$/i, '').replace(/_/g, ' ');
    var year = null, ym = base.match(/(19|20)\d\d/); if (ym) year = ym[0];
    var term = null;
    for (var t = 0; t < TERMS.length; t++) { if (new RegExp('\\b' + TERMS[t] + '\\b', 'i').test(base)) { term = TERMS[t]; break; } }
    var level = null, levelKey = null;
    for (var l = 0; l < LEVELS.length; l++) { if (new RegExp('\\b' + LEVELS[l][0] + '\\b', 'i').test(base)) { level = LEVELS[l][1]; levelKey = LEVELS[l][2]; break; } }
    return { year: year, term: term, level: level, levelKey: levelKey };
  }
  window.LEVEL_OPTIONS = LEVELS.filter(function (l, i, a) { return a.findIndex(function (x) { return x[1] === l[1]; }) === i; }).map(function (l) { return { label: l[1], key: l[2] }; });
  window.TERM_OPTIONS = TERMS;

  /* ── CSV → player records ────────────────────────────────── */
  function buildPlayerRecords(text) {
    var rows = parseCsv(stripBom(text));
    if (rows.length < 3) return { error: 'No player rows found in this file.' };
    if (rows[0].indexOf('Batting') === -1 && rows[1].indexOf('AVG') === -1)
      return { error: "This doesn't look like a GameChanger season-stats export." };
    var keys = buildHeaderKeys(rows[0], rows[1]);
    var idx = {}; keys.forEach(function (k, i) { if (!(k in idx)) idx[k] = i; });
    var g = function (r, k) { return (k in idx) ? r[idx[k]] : null; };
    var players = [];
    for (var ri = 2; ri < rows.length; ri++) {
      var r = rows[ri];
      if (!r.some(function (c) { return c && c.trim(); })) continue;
      var last = raw(g(r, 'id.Last')), first = raw(g(r, 'id.First'));
      if (!last && !first) continue; // skips Totals / Glossary rows
      var rec = { name: [first, last].filter(Boolean).join(' '), last: last, first: first, number: raw(g(r, 'id.Number')) };

      if ((num(g(r, 'bat.PA')) || 0) > 0) rec.bat = {
        GP: num(g(r, 'bat.GP')), PA: num(g(r, 'bat.PA')), AB: num(g(r, 'bat.AB')), R: num(g(r, 'bat.R')), H: num(g(r, 'bat.H')),
        _2B: num(g(r, 'bat.2B')), _3B: num(g(r, 'bat.3B')), HR: num(g(r, 'bat.HR')), RBI: num(g(r, 'bat.RBI')), BB: num(g(r, 'bat.BB')),
        SO: num(g(r, 'bat.SO')), HBP: num(g(r, 'bat.HBP')), SF: num(g(r, 'bat.SF')), SB: num(g(r, 'bat.SB')), CS: num(g(r, 'bat.CS')),
        AVG: raw(g(r, 'bat.AVG')), OBP: raw(g(r, 'bat.OBP')), SLG: raw(g(r, 'bat.SLG')), OPS: raw(g(r, 'bat.OPS')),
        TB: num(g(r, 'bat.TB')), XBH: num(g(r, 'bat.XBH')), QABp: raw(g(r, 'bat.QAB%')), BBK: raw(g(r, 'bat.BB/K')),
        Cp: raw(g(r, 'bat.C%')), BABIP: raw(g(r, 'bat.BABIP')), PSPA: raw(g(r, 'bat.PS/PA'))
      };

      if ((num(g(r, 'pit.BF')) || 0) > 0) rec.pit = {
        GP: num(g(r, 'pit.GP')), GS: num(g(r, 'pit.GS')), IP: raw(g(r, 'pit.IP')), BF: num(g(r, 'pit.BF')), P: num(g(r, 'pit.#P')),
        W: num(g(r, 'pit.W')), L: num(g(r, 'pit.L')), SV: num(g(r, 'pit.SV')), H: num(g(r, 'pit.H')), R: num(g(r, 'pit.R')), ER: num(g(r, 'pit.ER')),
        BB: num(g(r, 'pit.BB')), SO: num(g(r, 'pit.SO')), HR: num(g(r, 'pit.HR')), ERA: raw(g(r, 'pit.ERA')), WHIP: raw(g(r, 'pit.WHIP')),
        BAA: raw(g(r, 'pit.BAA')), FIP: raw(g(r, 'pit.FIP')), Sp: raw(g(r, 'pit.S%')), SMp: raw(g(r, 'pit.SM%')), FPSp: raw(g(r, 'pit.FPS%')),
        KBF: raw(g(r, 'pit.K/BF')), KBB: raw(g(r, 'pit.K/BB')),
        vFB: raw(g(r, 'pit.MPHFB')), vCB: raw(g(r, 'pit.MPHCB')), vCH: raw(g(r, 'pit.MPHCH')), vSL: raw(g(r, 'pit.MPHSL'))
      };

      var fINN = num(g(r, 'fie.INN')), fTC = num(g(r, 'fie.TC'));
      if ((fINN || 0) > 0 || (fTC || 0) > 0) {
        var pos = {};
        ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'].forEach(function (p) { var v = num(g(r, 'fie.' + p)); if (v) pos[p] = v; });
        rec.fld = {
          TC: num(g(r, 'fie.TC')), PO: num(g(r, 'fie.PO')), A: num(g(r, 'fie.A')), E: num(g(r, 'fie.E')),
          DP: num(g(r, 'fie.DP')), FPCT: raw(g(r, 'fie.FPCT')), PB: num(g(r, 'fie.PB')), SB: num(g(r, 'fie.SB')),
          CS: num(g(r, 'fie.CS')), CSp: raw(g(r, 'fie.CS%')), PIK: num(g(r, 'fie.PIK')), pos: pos
        };
      }
      players.push(rec);
    }
    return { players: players };
  }

  /* ── NAME MATCHING (exact → fuzzy → new) ─────────────────── */
  function rosterNames() {
    // Prefer the full known-player list (bullpen roster + anyone already added
    // via a previous stats import) so a player added from one file is matched —
    // not re-added — when they appear in another file.
    if (typeof window.getKnownPlayerNames === 'function') {
      var known = window.getKnownPlayerNames();
      if (known && known.length) return known;
    }
    var sel = document.getElementById('pitcher');
    var names = [];
    if (sel) for (var i = 0; i < sel.options.length; i++) { var v = sel.options[i].value; if (v) names.push(v); }
    return names;
  }
  function norm(s) { return String(s).toLowerCase().replace(/[^a-z]/g, ''); }
  function lev(a, b) {
    a = norm(a); b = norm(b);
    var m = a.length, n = b.length, d = [];
    for (var i = 0; i <= m; i++) d[i] = [i];
    for (var j = 0; j <= n; j++) d[0][j] = j;
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  function matchName(gcName, roster) {
    var target = norm(gcName);
    for (var i = 0; i < roster.length; i++) if (norm(roster[i]) === target) return { status: 'exact', match: roster[i] };
    var best = null, bestD = 99;
    roster.forEach(function (r) { var d = lev(gcName, r); if (d < bestD) { bestD = d; best = r; } });
    if (best && bestD <= 2) return { status: 'fuzzy', match: best };
    return { status: 'new', match: null };
  }

  /* ── IMPORT MODAL (built once, on demand) ────────────────── */
  var IMP = null; // {meta, players, matches[]}

  function ensureModal() {
    if (document.getElementById('gcImportModal')) return;
    var m = document.createElement('div');
    m.className = 'modal-overlay'; m.id = 'gcImportModal';
    m.innerHTML =
      '<div class="modal gc-modal">' +
        '<div class="modal-title">Import GameChanger Stats</div>' +
        '<div class="modal-subtitle" id="gcSub">Drop a season export to begin</div>' +
        '<div id="gcDrop" class="gc-drop"><div class="gc-drop-ic"><svg class="icon"><use href="#i-folder"/></svg></div>' +
          '<div class="gc-drop-t">Drop a GameChanger CSV here</div>' +
          '<div class="gc-drop-s">One file per team &amp; season · batting + pitching + fielding</div>' +
          '<button class="gc-browse" id="gcBrowse">or browse files</button>' +
          '<input type="file" id="gcFile" accept=".csv,text/csv" style="display:none;"></div>' +
        '<div id="gcStep" style="display:none;">' +
          '<div class="gc-tagrow">' +
            '<div class="modal-field"><label>Year</label><input type="text" id="gcYear" maxlength="4" inputmode="numeric"></div>' +
            '<div class="modal-field"><label>Term</label><select id="gcTerm"></select></div>' +
            '<div class="modal-field"><label>Level / Team</label><select id="gcLevel"></select></div>' +
          '</div>' +
          '<div class="gc-matchhead"><span>Name matching</span><span id="gcMatchMeta" class="hint"></span></div>' +
          '<div class="gc-match-wrap" id="gcMatchWrap"></div>' +
          '<div class="modal-field"><label>PIN Code</label><input type="password" id="gcPin" maxlength="4" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="Coach PIN"></div>' +
          '<div class="modal-status" id="gcStatus"></div>' +
        '</div>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-cancel" id="gcCancel">Cancel</button>' +
          '<button class="btn btn-sheets-send" id="gcGo" style="display:none;">⬆ Import</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);

    var fileInput = m.querySelector('#gcFile');
    m.querySelector('#gcBrowse').onclick = function () { fileInput.click(); };
    fileInput.onchange = function (e) { if (e.target.files[0]) readFile(e.target.files[0]); };
    m.querySelector('#gcCancel').onclick = closeImport;
    m.querySelector('#gcGo').onclick = doImport;
    m.onclick = function (e) { if (e.target === m) closeImport(); };

    var drop = m.querySelector('#gcDrop');
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('hot'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('hot'); }); });
    drop.addEventListener('drop', function (e) { var f = e.dataTransfer.files[0]; if (f) readFile(f); });
  }

  function openImport() { ensureModal(); resetImport(); document.getElementById('gcImportModal').classList.add('open'); }
  function closeImport() { var m = document.getElementById('gcImportModal'); if (m) m.classList.remove('open'); }
  function resetImport() {
    IMP = null;
    document.getElementById('gcDrop').style.display = 'block';
    document.getElementById('gcStep').style.display = 'none';
    document.getElementById('gcGo').style.display = 'none';
    document.getElementById('gcSub').textContent = 'Drop a season export to begin';
    document.getElementById('gcStatus').textContent = '';
    var fi = document.getElementById('gcFile'); if (fi) fi.value = '';
  }

  function readFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed = buildPlayerRecords(String(reader.result));
      if (parsed.error) { setStatus(parsed.error, 'error'); return; }
      var meta = parseStatFilename(file.name);
      IMP = { fileName: file.name, meta: meta, players: parsed.players };
      buildStep();
    };
    reader.onerror = function () { setStatus('Could not read that file.', 'error'); };
    reader.readAsText(file);
  }

  function buildStep() {
    var p = IMP.players, meta = IMP.meta;
    document.getElementById('gcDrop').style.display = 'none';
    document.getElementById('gcStep').style.display = 'block';
    document.getElementById('gcGo').style.display = 'inline-block';
    document.getElementById('gcSub').textContent = IMP.fileName;

    // tag fields
    document.getElementById('gcYear').value = meta.year || '';
    var termSel = document.getElementById('gcTerm');
    termSel.innerHTML = '<option value="">—</option>' + window.TERM_OPTIONS.map(function (t) { return '<option' + (t === meta.term ? ' selected' : '') + '>' + t + '</option>'; }).join('');
    var lvlSel = document.getElementById('gcLevel');
    lvlSel.innerHTML = window.LEVEL_OPTIONS.map(function (l) { return '<option value="' + l.key + '"' + (l.label === meta.level ? ' selected' : '') + '>' + l.label + '</option>'; }).join('');

    // name matching
    var roster = rosterNames();
    IMP.matches = p.map(function (pl) { return matchName(pl.name, roster); });
    var counts = { exact: 0, fuzzy: 0, 'new': 0 };
    IMP.matches.forEach(function (mt) { counts[mt.status]++; });
    document.getElementById('gcMatchMeta').textContent =
      p.length + ' players · ' + counts.exact + ' matched · ' + counts.fuzzy + ' fuzzy · ' + counts['new'] + ' new';

    var esc = window.escapeHtml || function (s) { return String(s == null ? '' : s); };
    var optsFor = function (sel) {
      return roster.map(function (r) { return '<option value="' + esc(r) + '"' + (r === sel ? ' selected' : '') + '>' + esc(r) + '</option>'; }).join('');
    };
    var rowsHtml = p.map(function (pl, i) {
      var mt = IMP.matches[i];
      var badge = mt.status === 'exact' ? '<span class="gc-ms ok">✓ exact</span>'
        : mt.status === 'fuzzy' ? '<span class="gc-ms fuzzy">~ fuzzy</span>'
          : '<span class="gc-ms new">＋ new</span>';
      var sides = (pl.bat ? 'B' : '') + (pl.pit ? 'P' : '') + (pl.fld ? 'F' : '');
      var sel = '<select class="gc-msel" data-i="' + i + '">' +
        '<option value="__new__"' + (mt.status === 'new' ? ' selected' : '') + '>＋ Add "' + esc(pl.name) + '"</option>' +
        optsFor(mt.match) + '</select>';
      return '<div class="gc-mrow"><div class="gc-gcname">' + esc(pl.name) + (pl.number ? ' <span class="gc-num">#' + esc(pl.number) + '</span>' : '') +
        ' <span class="gc-sides">' + sides + '</span></div><div class="gc-msel-wrap">' + sel + '</div>' + badge + '</div>';
    }).join('');
    document.getElementById('gcMatchWrap').innerHTML = rowsHtml;
    setStatus('', '');
  }

  function setStatus(msg, kind) {
    var el = document.getElementById('gcStatus'); if (!el) return;
    el.textContent = msg || '';
    el.className = 'modal-status' + (kind ? ' ' + kind : '');
  }

  async function doImport() {
    if (!IMP) return;
    var pin = (document.getElementById('gcPin').value || '').trim();
    if (pin !== '2149') { setStatus('Incorrect PIN code', 'error'); return; }
    var year = (document.getElementById('gcYear').value || '').trim();
    var term = document.getElementById('gcTerm').value || '';
    var lvlSel = document.getElementById('gcLevel');
    var levelKey = lvlSel.value, level = lvlSel.options[lvlSel.selectedIndex].text;
    if (!/^\d{4}$/.test(year)) { setStatus('Enter a 4-digit year', 'error'); return; }
    if (!level) { setStatus('Pick a level', 'error'); return; }

    // resolve chosen names from the match dropdowns
    document.querySelectorAll('.gc-msel').forEach(function (s) {
      var i = +s.dataset.i, v = s.value;
      IMP.players[i].name = (v === '__new__') ? IMP.players[i].name : v;
    });

    setStatus('Importing…', '');
    document.getElementById('gcGo').disabled = true;
    try {
      var res = await window.gasCall(null, {
        action: 'import_stats',
        meta: JSON.stringify({ year: year, term: term, level: level, levelKey: levelKey }),
        players: JSON.stringify(IMP.players)
      });
      if (!res.success) throw new Error(res.error || 'Import failed');
      if (typeof showToast === 'function') showToast('Imported ' + res.imported + ' players · ' + level + ' ' + year);
      closeImport();
      if (typeof window.loadPlayersHub === 'function') window.loadPlayersHub(true);
    } catch (e) {
      setStatus('Error: ' + e.message, 'error');
    } finally {
      document.getElementById('gcGo').disabled = false;
    }
  }

  /* ── PUBLIC ──────────────────────────────────────────────── */
  window.openImportModal = openImport;
  window.gcDropFile = function (file) { openImport(); readFile(file); };
  window.gcParseFile = readFile;          // used by the hub drop zone
  window.gcBuildRecords = buildPlayerRecords; // exposed for testing
})();
