/* Headless release verification for lakers-bullpen (built for v35).
   Serves public/ locally, swaps the Firebase SDK for the in-memory mock,
   and asserts boot, view isolation, and feature checks at 1400px + 390px.
   Run: cd verify && npm i && node verify.js */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const PUB = path.join(__dirname, '..', 'public');
const MOCK = path.join(__dirname, 'mock-firebase.js');
// newest cached Chrome from puppeteer's cache; override with CHROME_PATH env
const CHROME = process.env.CHROME_PATH || (() => {
  const base = path.join(process.env.HOME, '.cache/puppeteer/chrome');
  const v = fs.readdirSync(base).sort().pop();
  return path.join(base, v, 'chrome-linux64', 'chrome');
})();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(PUB, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

let failures = [];
function check(name, ok, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name + (detail ? ' — ' + detail : ''));
}

async function setupPage(page) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.includes('firebase-app-compat.js')) {
      req.respond({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(MOCK, 'utf8') });
    } else if (u.includes('firebase-firestore-compat.js') || u.includes('/__/firebase/init.js')) {
      req.respond({ status: 200, contentType: 'text/javascript', body: '/* mocked */' });
    } else if (u.startsWith('https://fonts.') || u.startsWith('https://www.gstatic.com')) {
      req.respond({ status: 200, contentType: 'text/css', body: '' });
    } else {
      req.continue();
    }
  });
  return errors;
}

async function runViewport(browser, width, height, label) {
  console.log('\n== ' + label + ' (' + width + 'x' + height + ') ==');
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  const errors = await setupPage(page);

  await page.goto('http://127.0.0.1:8135/', { waitUntil: 'domcontentloaded' });

  // -- splash: visible, grooves+stitches built from the guide paths
  const splashUp = await page.evaluate(() => {
    const s = document.getElementById('splash');
    return {
      present: !!s, shown: !!s && getComputedStyle(s).display !== 'none',
      grooves: document.querySelectorAll('#spGrooves path').length,
      stitches: document.querySelectorAll('#spStitches *').length
    };
  });
  check('splash visible on boot', splashUp.present && splashUp.shown);
  check('seam grooves built', splashUp.grooves >= 2, splashUp.grooves + ' groove paths');
  check('chevron stitches built', splashUp.stitches >= 20, splashUp.stitches + ' stitch nodes');

  // -- splash resolves (min dwell 5.8s, 10s cap) and is removed from the DOM
  const gone = await page.waitForFunction(() => !document.getElementById('splash'), { timeout: 13000 }).then(() => true).catch(() => false);
  check('splash resolves and is removed <13s', gone);

  // -- players hub rendered with seeded data
  const hub = await page.evaluate(() => {
    const grid = document.getElementById('viewPlayers');
    return {
      visible: grid && getComputedStyle(grid).display !== 'none',
      hasAnderson: !!grid && grid.textContent.includes('Anderson'),
      hasBerg: !!grid && grid.textContent.includes('Berg'),
      rows: document.querySelectorAll('#viewPlayers tbody tr').length
    };
  });
  check('players hub visible + seeded rows', hub.visible && hub.hasAnderson && hub.hasBerg, hub.rows + ' rows');

  // -- v35 icon sprite in use, emoji chrome gone from header/waffle
  const icons = await page.evaluate(() => {
    const sprite = !!document.getElementById('i-players');
    const uses = document.querySelectorAll('svg.icon use').length;
    const waffle = document.getElementById('waffleMenu');
    const emojiLeft = waffle ? /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}]/u.test(waffle.textContent) : true;
    const crest = document.querySelector('.brand-crest');
    return { sprite, uses, emojiLeft, crest: !!crest && crest.complete && crest.naturalWidth > 0 };
  });
  check('icon sprite present + referenced', icons.sprite && icons.uses > 10, icons.uses + ' uses');
  check('no emoji left in waffle menu', !icons.emojiLeft);
  check('header block-M crest loads', icons.crest);

  // -- v35 two-row filter toolbar behaviour
  const toolbar = await page.evaluate(() => {
    const row = document.getElementById('pfSearchRow');
    return { present: !!row, tight: !!row && row.classList.contains('pf-tight') };
  });
  check('filter toolbar present', toolbar.present, toolbar.tight ? 'collapsed search (pf-tight)' : 'full search field');

  // -- v37: video library removed; players filters one row on desktop
  const v37 = await page.evaluate(() => {
    const pf = document.querySelector('.players-filters');
    const rows = document.querySelectorAll('.players-filters .pf-row');
    return {
      videoGone: !document.getElementById('viewVideo'),
      dir: pf ? getComputedStyle(pf).flexDirection : '',
      sameLine: rows.length === 2 && Math.abs(rows[0].offsetTop - rows[1].offsetTop) < 4
    };
  });
  check('video library view removed', v37.videoGone);
  if (width >= 601) check('players filters on one row', v37.dir === 'row' && v37.sameLine, v37.dir);
  else check('players filters stacked on mobile', v37.dir === 'column', v37.dir);

  // -- v37: scroll-shrink header at every width (was mobile-only)
  await page.evaluate(() => { document.body.style.minHeight = '3000px'; window.scrollTo(0, 400); });
  await new Promise(r => setTimeout(r, 400));
  const compactOn = await page.evaluate(() => document.documentElement.classList.contains('hdr-compact'));
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await new Promise(r => setTimeout(r, 400));
  const compactOff = await page.evaluate(() => { document.body.style.minHeight = ''; return !document.documentElement.classList.contains('hdr-compact'); });
  check('header shrinks on scroll', compactOn);
  check('header restores at top', compactOff);

  // -- view isolation: switch through every view, exactly one visible
  const VIEWS = [['tracker', 'viewTracker'], ['sheet', 'viewSheet'], ['board', 'viewBoard'], ['players', 'viewPlayers']];
  for (const [name, id] of VIEWS) {
    await page.evaluate(n => window.switchView(n), name);
    await new Promise(r => setTimeout(r, 350));
    const bleed = await page.evaluate(activeId => {
      const all = ['viewTracker', 'viewSheet', 'viewPlayers', 'viewBoard', 'viewPlayer'];
      const shown = all.filter(i => { const el = document.getElementById(i); return el && getComputedStyle(el).display !== 'none'; });
      return { shown, ok: shown.length === 1 && shown[0] === activeId };
    }, id);
    check('view "' + name + '" isolated', bleed.ok, 'visible: ' + bleed.shown.join(','));
  }

  // -- v35 live pad (Decision 4A): Dynamic session drives pad logging
  await page.evaluate(() => window.switchView('tracker'));
  const pad = await page.evaluate(async () => {
    const out = {};
    document.getElementById('sessionType').value = 'dynamic';
    window.onSessionTypeChange();
    const sel = document.getElementById('pitcher');
    out.rosterLoaded = sel.options.length > 1;
    sel.value = sel.options[1] ? sel.options[1].value : '';
    window.generateSession();
    const padEl = document.getElementById('livePad');
    const title = () => document.getElementById('lpTitle').textContent.trim();
    out.padVisible = padEl && getComputedStyle(padEl).display !== 'none';
    out.startTitle = title();
    // each pad action commits one pitch: zone taps (strike=exec, ball=notexec)
    // and the quick-result buttons (no location) — 4 actions = 4 pitches
    window.lpZoneTap(4);          // FA, middle-middle → executed
    window.lpLogResult('exec');   // FA, no location
    window.lpSetType('BB');
    window.lpZoneTap(0);          // BB, corner strike cell
    window.lpLogResult('notexec');// BB, no location
    out.afterFour = title();
    window.lpUndo();
    out.afterUndo = title();
    return out;
  });
  check('dynamic roster loaded from seed', pad.rosterLoaded);
  check('live pad shows for dynamic session', pad.padVisible);
  check('pad logs pitches', pad.startTitle === 'PITCH 1' && pad.afterFour === 'PITCH 5', pad.startTitle + ' → ' + pad.afterFour);
  check('pad undo removes last pitch', pad.afterUndo === 'PITCH 4', 'after undo: ' + pad.afterUndo);

  // -- leaderboard renders seeded bullpen summary
  await page.evaluate(() => window.switchView('sheet'));
  await new Promise(r => setTimeout(r, 600));
  const sheet = await page.evaluate(() => {
    const v = document.getElementById('viewSheet');
    return v ? v.textContent.includes('Berg') : false;
  });
  check('leaderboard shows seeded pitcher', sheet);

  // -- v36: names render First Last (stored 'Berg, Tyler' must display 'Tyler Berg')
  const lbName = await page.evaluate(() => {
    const cell = document.querySelector('#dataBody tr td');
    return cell ? cell.textContent.replace('▶', '').trim() : null;
  });
  check('leaderboard name is First Last', lbName === 'Tyler Berg', String(lbName));

  // -- v36: player card opened from the leaderboard titles First Last
  await page.evaluate(() => { document.querySelector('#dataBody tr td').click(); });
  await new Promise(r => setTimeout(r, 800));
  const cardTitle = await page.evaluate(() => document.getElementById('playerCardName').textContent.trim());
  check('player card title First Last via leaderboard', cardTitle === 'Tyler Berg', cardTitle);

  // -- console errors (whole run)
  const realErrors = errors.filter(e => !e.includes('favicon'));
  check('no console/page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await page.screenshot({ path: path.join(__dirname, 'shot-' + label + '.png'), fullPage: false });
  await page.close();
}

// v36: under prefers-reduced-motion the splash must still play (statically),
// not be skipped — that was the desktop "splash never shows" bug.
async function runReducedMotion(browser) {
  console.log('\n== reduced-motion (1400x900) ==');
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await setupPage(page);
  await page.goto('http://127.0.0.1:8135/', { waitUntil: 'domcontentloaded' });
  const sp = await page.evaluate(() => {
    const s = document.getElementById('splash');
    const ball = document.querySelector('.sp-ball');
    return {
      present: !!s, shown: !!s && getComputedStyle(s).display !== 'none',
      ballAnim: ball ? getComputedStyle(ball).animationName : ''
    };
  });
  check('reduced-motion: splash still plays', sp.present && sp.shown);
  check('reduced-motion: ball spin disabled', sp.ballAnim === 'none', sp.ballAnim);
  const gone = await page.waitForFunction(() => !document.getElementById('splash'), { timeout: 13000 }).then(() => true).catch(() => false);
  check('reduced-motion: splash resolves and is removed', gone);
  await page.close();
}

(async () => {
  server.listen(8135);
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    await runViewport(browser, 1400, 900, 'desktop');
    await runViewport(browser, 390, 844, 'mobile');
    await runReducedMotion(browser);
  } finally {
    await browser.close();
    server.close();
  }
  console.log('\n' + (failures.length ? 'FAILURES: ' + failures.length : 'ALL CHECKS PASSED'));
  process.exit(failures.length ? 1 : 0);
})();
