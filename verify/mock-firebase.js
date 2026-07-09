/* Mock of the Firebase compat SDK for headless verification.
   Served in place of the gstatic firebase-app/firestore scripts.
   In-memory Firestore supporting the exact surface the app uses:
   collection / doc / get / set / add / delete / collectionGroup /
   enablePersistence / settings / FieldValue.serverTimestamp. */
(function () {
  var STORE = {}; // full doc path -> data object

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function autoId() { return 'auto_' + Math.random().toString(36).slice(2, 10); }

  function docSnap(path) {
    var segs = path.split('/');
    var id = segs[segs.length - 1];
    var parentDocId = segs.length >= 3 ? segs[segs.length - 3] : null;
    return {
      id: id,
      exists: Object.prototype.hasOwnProperty.call(STORE, path),
      data: function () { return STORE[path] ? clone(STORE[path]) : undefined; },
      ref: { id: id, parent: { parent: parentDocId ? { id: parentDocId } : null } }
    };
  }

  function DocRef(path) {
    var segs = path.split('/');
    return {
      id: segs[segs.length - 1],
      get: function () { return Promise.resolve(docSnap(path)); },
      set: function (data, opts) {
        if (opts && opts.merge && STORE[path]) {
          Object.assign(STORE[path], clone(data));
        } else {
          STORE[path] = clone(data);
        }
        return Promise.resolve();
      },
      update: function (data) {
        STORE[path] = Object.assign(STORE[path] || {}, clone(data));
        return Promise.resolve();
      },
      delete: function () { delete STORE[path]; return Promise.resolve(); },
      collection: function (name) { return CollRef(path + '/' + name); }
    };
  }

  function querySnap(paths) {
    var docs = paths.map(docSnap);
    return {
      empty: docs.length === 0,
      size: docs.length,
      docs: docs,
      forEach: function (fn) { docs.forEach(fn); }
    };
  }

  function CollRef(path) {
    var depth = path.split('/').length + 1;
    var ref = {
      doc: function (id) { return DocRef(path + '/' + (id != null ? String(id) : autoId())); },
      add: function (data) {
        var d = DocRef(path + '/' + autoId());
        return d.set(data).then(function () { return d; });
      },
      get: function () {
        var out = Object.keys(STORE).filter(function (p) {
          return p.indexOf(path + '/') === 0 && p.split('/').length === depth;
        });
        return Promise.resolve(querySnap(out));
      },
      // filters ignored — seed data is small enough that callers tolerate supersets
      where: function () { return ref; },
      orderBy: function () { return ref; },
      limit: function () { return ref; }
    };
    return ref;
  }

  var db = {
    collection: function (name) { return CollRef(name); },
    collectionGroup: function (name) {
      return {
        get: function () {
          var out = Object.keys(STORE).filter(function (p) {
            var s = p.split('/');
            return s.length >= 2 && s[s.length - 2] === name;
          });
          return Promise.resolve(querySnap(out));
        }
      };
    },
    settings: function () {},
    enablePersistence: function () { return Promise.resolve(); }
  };

  var firestoreFn = function () { return db; };
  firestoreFn.FieldValue = { serverTimestamp: function () { return new Date().toISOString(); } };

  window.firebase = {
    // pre-initialized, mirroring Firebase Hosting auto-init (/__/firebase/init.js)
    apps: [{}],
    initializeApp: function () { window.firebase.apps.push({}); return {}; },
    firestore: firestoreFn
  };

  /* ── seed: realistic Lakers data ─────────────────────────── */
  STORE['config/app'] = { currentSeason: '2026', seasons: ['2026', '2025'] };
  STORE['seasons/2026'] = { roster: ['Anderson, Cole', 'Berg, Tyler', 'Carlson, Mason', 'Dahl, Owen', 'Erickson, Jack', 'Foss, Landon'] };
  STORE['seasons/2025'] = { roster: ['Anderson, Cole', 'Berg, Tyler'] };

  function bat(pa, ab, h, hr, bb, so) {
    var avg = (h / ab).toFixed(3).replace(/^0/, '');
    return { GP: 18, PA: pa, AB: ab, R: 12, H: h, _2B: 4, _3B: 1, HR: hr, RBI: 14, BB: bb,
      SO: so, HBP: 1, SF: 1, SB: 6, CS: 1, AVG: avg, OBP: '.452', SLG: '.618', OPS: '1.070',
      TB: h + 8, XBH: 6, QABp: '58', BBK: '0.75', Cp: '82', BABIP: '.404', PSPA: '3.8' };
  }
  function pit(ip, er, so, bb) {
    return { GP: 8, GS: 6, IP: ip, BF: 140, P: 520, W: 4, L: 1, SV: 0, H: 25, R: 12, ER: er,
      BB: bb, SO: so, HR: 1, ERA: '1.95', WHIP: '1.11', BAA: '.198', FIP: '2.40', Sp: '64',
      SMp: '13', FPSp: '61', KBF: '0.29', KBB: '3.7', vFB: '82', vCB: '68', vCH: '74', vSL: null };
  }
  function fld(pos) {
    return { TC: 45, PO: 30, A: 12, E: 3, DP: 2, FPCT: '.933', PB: 0, SB: 4, CS: 2, CSp: '33', PIK: 0, pos: pos };
  }

  // Varsity qualifier (62 PA), bats + fields
  STORE['players/Cole_Anderson'] = { name: 'Cole Anderson', number: '7', bats: true, pitches: false, fields: true,
    levels: ['V'], years: ['2026', '2025'], positions: ['SS'], statlineCount: 2,
    AVG: '.382', OBP: '.452', SLG: '.618', OPS: '1.070', HR: 2, SB: 6, RBI: 14 };
  STORE['players/Cole_Anderson/statlines/2026_Spring_V'] = { name: 'Cole Anderson', number: '7',
    year: '2026', term: 'Spring', level: 'Varsity', levelKey: 'V', bat: bat(62, 55, 21, 2, 6, 8), fld: fld({ SS: 16, P: 2 }) };
  STORE['players/Cole_Anderson/statlines/2025_Spring_V'] = { name: 'Cole Anderson', number: '7',
    year: '2025', term: 'Spring', level: 'Varsity', levelKey: 'V', bat: bat(48, 43, 14, 1, 4, 10), fld: fld({ SS: 14 }) };

  // Two-way varsity arm (qualifies both ways: 40 PA, 32.1 IP)
  STORE['players/Tyler_Berg'] = { name: 'Tyler Berg', number: '12', bats: true, pitches: true, fields: true,
    levels: ['V'], years: ['2026'], positions: ['P', '1B'], statlineCount: 1,
    AVG: '.311', ERA: '1.95', WHIP: '1.11', SO: 41, HR: 1, SB: 2, RBI: 11 };
  STORE['players/Tyler_Berg/statlines/2026_Spring_V'] = { name: 'Tyler Berg', number: '12',
    year: '2026', term: 'Spring', level: 'Varsity', levelKey: 'V',
    bat: bat(40, 36, 11, 1, 3, 9), pit: pit('32.1', 9, 41, 11), fld: fld({ P: 8, '1B': 9 }) };

  // JV arm under the 5 IP qualifier (tests Qualifiers filter)
  STORE['players/Mason_Carlson'] = { name: 'Mason Carlson', number: '21', bats: false, pitches: true, fields: false,
    levels: ['JV'], years: ['2026'], positions: ['P'], statlineCount: 1, ERA: '3.86', WHIP: '1.50', SO: 6 };
  STORE['players/Mason_Carlson/statlines/2026_Spring_JV'] = { name: 'Mason Carlson', number: '21',
    year: '2026', term: 'Spring', level: 'JV', levelKey: 'JV', pit: pit('4.2', 2, 6, 3) };

  // JV bat under the 15 PA qualifier
  STORE['players/Owen_Dahl'] = { name: 'Owen Dahl', number: '4', bats: true, pitches: false, fields: true,
    levels: ['JV'], years: ['2026'], positions: ['2B'], statlineCount: 1, AVG: '.250' };
  STORE['players/Owen_Dahl/statlines/2026_Spring_JV'] = { name: 'Owen Dahl', number: '4',
    year: '2026', term: 'Spring', level: 'JV', levelKey: 'JV', bat: bat(12, 12, 3, 0, 0, 4), fld: fld({ '2B': 10 }) };

  // Bullpen tracker data — season pitchers + sessions
  function penPitch(n, type, del, zone, res, velo) {
    return { number: n, pitchType: type, delivery: del, zone: zone, result: res, velo: velo };
  }
  STORE['seasons/2026/pitchers/Berg_Tyler'] = { name: 'Berg, Tyler', exec: 66.7,
    faAvg: 78.5, faExec: 75, cbAvg: 66, cbExec: 50, chAvg: 71, chExec: 66.7,
    faCount: 4, cbCount: 2, chCount: 3, totalPitches: 9 };
  STORE['seasons/2026/pitchers/Berg_Tyler/sessions/s1'] = {
    date: '2026-06-20', sessionType: 'Bullpen',
    pitches: [
      penPitch(1, 'FA', 'Windup', 5, 'Executed', 78), penPitch(2, 'FA', 'Windup', 1, 'Executed', 79),
      penPitch(3, 'FA', 'Stretch', 3, 'Not Executed', 78), penPitch(4, 'FA', 'Stretch', 5, 'Executed', 79),
      penPitch(5, 'BB', 'Windup', 7, 'Executed', 66), penPitch(6, 'BB', 'Stretch', 9, 'Not Executed', 66),
      penPitch(7, 'CH', 'Windup', 8, 'Executed', 71), penPitch(8, 'CH', 'Stretch', 8, 'Executed', 70),
      penPitch(9, 'CH', 'Stretch', 2, 'Not Executed', 72)
    ]
  };
})();
