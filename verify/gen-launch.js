/* iOS launch-image generator (v40, launch pick A).
   Renders the full brand lockup — crest, MINNEWASKA, LAKERS BASEBALL, color
   bar — on the Seam Trace backdrop at every supported device size, writing
   PNGs to public/launch/ and printing the <link rel="apple-touch-startup-image">
   tags for index.html. Everything is sized in vmin so the lockup scales with
   the device exactly like the in-app splash it hands off to.
   Run: cd verify && node gen-launch.js */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const OUT = path.join(__dirname, '..', 'public', 'launch');
const CREST = fs.readFileSync(path.join(__dirname, '..', 'public', 'block-m.png')).toString('base64');
// Latin woff2 subsets, base64 (verify/fonts/) — embedded so the render needs
// no network and stays byte-identical run to run.
const BEBAS = fs.readFileSync(path.join(__dirname, 'fonts', 'BebasNeue-400.b64'), 'utf8').trim();
const PLEX = fs.readFileSync(path.join(__dirname, 'fonts', 'IBMPlexMono-600.b64'), 'utf8').trim();
const CHROME = process.env.CHROME_PATH || (() => {
  const base = path.join(process.env.HOME, '.cache/puppeteer/chrome');
  const v = fs.readdirSync(base).sort().pop();
  return path.join(base, v, 'chrome-linux64', 'chrome');
})();

// [device-width pts, device-height pts, pixel ratio, orientations]
const DEVICES = [
  [375, 667, 2, ['portrait']],            // iPhone 8 / SE 2·3
  [375, 812, 3, ['portrait']],            // iPhone X/XS/11 Pro/12·13 mini
  [390, 844, 3, ['portrait']],            // iPhone 12/13/14/15/16e
  [393, 852, 3, ['portrait']],            // iPhone 14/15/16 Pro
  [402, 874, 3, ['portrait']],            // iPhone 16 Pro (17 line)
  [414, 896, 2, ['portrait']],            // iPhone XR/11
  [414, 896, 3, ['portrait']],            // iPhone XS Max/11 Pro Max
  [428, 926, 3, ['portrait']],            // iPhone 12/13 Pro Max, 14 Plus
  [430, 932, 3, ['portrait']],            // iPhone 14/15 Pro Max, 15/16 Plus
  [440, 956, 3, ['portrait']],            // iPhone 16 Pro Max
  [768, 1024, 2, ['portrait', 'landscape']],  // iPad 9.7 / mini
  [810, 1080, 2, ['portrait', 'landscape']],  // iPad 10.2
  [820, 1180, 2, ['portrait', 'landscape']],  // iPad 10.9
  [834, 1112, 2, ['portrait', 'landscape']],  // iPad Air 10.5
  [834, 1194, 2, ['portrait', 'landscape']],  // iPad Pro 11 / Air 11
  [1024, 1366, 2, ['portrait', 'landscape']]  // iPad Pro 12.9 / 13
];

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>
@font-face{font-family:'Bebas Neue';font-weight:400;src:url(data:font/woff2;base64,${BEBAS}) format('woff2');}
@font-face{font-family:'IBM Plex Mono';font-weight:600;src:url(data:font/woff2;base64,${PLEX}) format('woff2');}
*{margin:0;padding:0;}
html,body{width:100%;height:100%;}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;
  background:radial-gradient(100% 100% at 50% 40%,#0a2036 0%,#050d17 70%);}
img{width:30vmin;display:block;filter:drop-shadow(0 2vmin 6vmin rgba(0,0,0,0.55));}
.school{font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:2.6vmin;letter-spacing:0.45em;
  text-indent:0.45em;color:#A6C3E6;margin-top:4vmin;}
.main{font-family:'Bebas Neue',sans-serif;font-size:8.6vmin;letter-spacing:0.09em;line-height:1.1;color:#fff;margin-top:1vmin;}
.main i{font-style:normal;color:#A6C3E6;margin-left:2.2vmin;}
.bar{display:flex;height:1vmin;width:46vmin;margin-top:3.4vmin;border-radius:0.5vmin;overflow:hidden;}
.bar span{flex:1;}
.b{background:#104D97;}.g{background:#028342;}.s{background:#A8B4C0;}
</style></head><body>
<img src="data:image/png;base64,${CREST}" alt="">
<div class="school">MINNEWASKA</div>
<div class="main">LAKERS<i>BASEBALL</i></div>
<div class="bar"><span class="b"></span><span class="g"></span><span class="s"></span><span class="g"></span><span class="b"></span></div>
</body></html>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const links = [];
  for (const [w, h, dpr, orientations] of DEVICES) {
    for (const orient of orientations) {
      const vw = orient === 'portrait' ? w : h, vh = orient === 'portrait' ? h : w;
      const px = vw * dpr, py = vh * dpr;
      const name = `launch-${px}x${py}.png`;
      await page.setViewport({ width: vw, height: vh, deviceScaleFactor: dpr });
      await page.setContent(HTML, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      await new Promise(r => setTimeout(r, 120));
      await page.screenshot({ path: path.join(OUT, name) });
      links.push(`<link rel="apple-touch-startup-image" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: ${orient})" href="launch/${name}">`);
      console.log(name, vw + 'x' + vh + '@' + dpr, orient);
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, 'launch-links.html'), links.join('\n') + '\n');
  console.log('\n' + links.length + ' images → public/launch/ · link tags → verify/launch-links.html');
})();
