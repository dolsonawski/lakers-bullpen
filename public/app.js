let pitches=[],marks=[],sessionActive=false;
const SHEETS_URL_KEY='bullpen_tracker_sheets_url';
const DEFAULT_SHEETS_URL='https://script.google.com/macros/s/AKfycbzebK1Avr221jSD-kZZKoUR4T7cIAaM3SiTMynpbEfe1Qv4NQjT9xjSfUPA0VTLuGvv/exec';

// Shared string-safety helpers — anything sourced from Firestore or a CSV
// import (player names, video URLs) must pass through these before landing
// in innerHTML, since writes to those collections aren't PIN-checked at the
// database level (see firestore.rules) and could carry a crafted payload.
const HTML_ESCAPES={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
function escapeHtml(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>HTML_ESCAPES[c]);}
function safeHref(url){const u=String(url==null?'':url).trim();return /^https?:\/\//i.test(u)?escapeHtml(u):'#';}
window.escapeHtml=escapeHtml;
window.safeHref=safeHref;

function getVal(id){return Math.max(0,parseInt(document.getElementById(id).value)||0);}
function updateTotals(){const s=getVal('fb_s')+getVal('ch_s')+getVal('cb_s'),w=getVal('fb_w')+getVal('ch_w')+getVal('cb_w');document.getElementById('totalStretch').textContent=s;document.getElementById('totalWindup').textContent=w;document.getElementById('grandTotal').textContent=s+w;document.getElementById('configError').textContent=(s+w===0)?'Add at least 1 pitch':'';document.getElementById('btnGenerate').disabled=(s+w===0);}

function buildPitchList(){const list=[];[{name:'FA',cls:'fastball',s:getVal('fb_s'),w:getVal('fb_w')},{name:'CH',cls:'changeup',s:getVal('ch_s'),w:getVal('ch_w')},{name:'BB',cls:'breaking-ball',s:getVal('cb_s'),w:getVal('cb_w')}].forEach(t=>{for(let i=0;i<t.s;i++)list.push({type:t.name,cls:t.cls,delivery:'Stretch'});for(let i=0;i<t.w;i++)list.push({type:t.name,cls:t.cls,delivery:'Windup'});});return list;}

function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}}

// Ordered sequence: all Windup pitches first (FA → BB → CH), then all Stretch pitches (FA → BB → CH).
// Within each pitch-type group the individual reps are shuffled so the session feels varied.
function arrangeWithBlocks(list){
  const order=['FA','BB','CH'];
  const result=[];
  ['Windup','Stretch'].forEach(delivery=>{
    order.forEach(type=>{
      const group=list.filter(p=>p.delivery===delivery&&p.type===type);
      shuffle(group);
      group.forEach(p=>result.push(p));
    });
  });
  return result;
}

function getSessionType(){return document.getElementById('sessionType').value;}

function onSessionTypeChange(){
  const t=getSessionType();
  const configPanel=document.getElementById('configPanel');
  const ruleNote=document.getElementById('ruleNote');
  const btnGen=document.getElementById('btnGenerate');
  const btnRand=document.getElementById('btnRandomize');
  if(t==='preset'){
    configPanel.style.display='';
    ruleNote.innerHTML='<svg class="icon"><use href="#i-bolt"/></svg> Session order: Windup (FA → BB → CH) then Stretch (FA → BB → CH) · Reps within each group are shuffled · Use Randomize to re-shuffle';
    btnGen.innerHTML='<svg class="icon"><use href="#i-ball"/></svg> Build Session';
    btnRand.style.display='';
  } else if(t==='dynamic'){
    configPanel.style.display='none';
    ruleNote.innerHTML='<svg class="icon"><use href="#i-bolt"/></svg> Dynamic Bullpen — the live pad logs each pitch as it\'s thrown: pick type/delivery, tap the zone · tap a # in the log to fix a pitch';
    btnGen.innerHTML='<svg class="icon"><use href="#i-ball"/></svg> Start Dynamic Bullpen';
    btnRand.style.display='none';
  } else if(t==='game'){
    configPanel.style.display='none';
    ruleNote.innerHTML='<svg class="icon"><use href="#i-bolt"/></svg> Game Mode — the live pad logs each pitch as it\'s thrown; the count is always exactly the pitches thrown (feeds the rest-day board)';
    btnGen.innerHTML='<svg class="icon"><use href="#i-ball"/></svg> Start Game';
    btnRand.style.display='none';
  }
}

function generateSession(){
  const t=getSessionType();
  let list=[];
  if(t==='preset'){
    list=buildPitchList();
    if(!list.length)return;
    pitches=arrangeWithBlocks(list);
  } else {
    // v35 live pad (Dynamic + Game): no pre-generated blanks — each pitch is
    // created the moment it's logged from the pad, so the session is always
    // exactly the pitches thrown (no +10, no Clear Blanks).
    pitches=[];
  }
  marks=new Array(pitches.length).fill(null);
  zoneSelections.length=0;
  pitches.forEach(()=>zoneSelections.push(-1));
  sessionActive=true;
  document.getElementById('trackerSection').classList.add('visible');
  document.getElementById('emptyState').style.display='none';
  document.getElementById('addPitchRow').style.display=(t==='preset')?'flex':'none';
  document.getElementById('sheetsButtonTop').style.display='block';
  document.getElementById('sheetsButtonBottom').style.display='block';
  const mp=document.getElementById('locationMapPanel');
  if(mp)mp.style.display='none';
  document.getElementById('btnRandomize').disabled=(t!=='preset');
  document.getElementById('btnClearBlanks').disabled=(t!=='preset');
  document.getElementById('btnReset').disabled=false;
  render(true);
  lpSync();
}
function randomize(){if(!sessionActive||getSessionType()!=='preset')return;pitches=arrangeWithBlocks(buildPitchList());marks=new Array(pitches.length).fill(null);zoneSelections.length=0;pitches.forEach(()=>zoneSelections.push(-1));const mp=document.getElementById('locationMapPanel');if(mp)mp.style.display='none';render(true);}
function resetMarks(){const t=getSessionType();if(t!=='preset'){pitches=[];}marks=new Array(pitches.length).fill(null);zoneSelections.length=0;pitches.forEach(()=>zoneSelections.push(-1));document.getElementById('pitcher').value='';render(false);updateLocationMap();lpSync();}
function toggleMark(i,t){marks[i]=marks[i]===t?null:t;updateRow(i);updateSummary();updateLocationMap();}

/* =========================================================
   ZONE GRID — 20×20 layout (canvas-based)
   Col indices 0-19 (L→R from pitcher's view): far-in → far-out
   Row indices 0-19 (T→B):                   high-ball → low-ball
   Inner 12×12 (rows 4-15, cols 4-15) = strike zone
   Outer 4-cell ring                   = ball zones

   Flat index = row*20 + col
   ========================================================= */
const ZONE_SIZE=20;
const GRID_PX=120; // pixel size of the grid canvas
const CELL_PX=GRID_PX/ZONE_SIZE; // 6px per cell

// Strike zone = inner 12×12 (rows 4-15, cols 4-15)
const SZ_R0=4,SZ_R1=15,SZ_C0=4,SZ_C1=15;

// Build label for each of the 400 cells — format R##C## (zero-padded)
function zoneLabel20(row,col){
  return'R'+String(row).padStart(2,'0')+'C'+String(col).padStart(2,'0');
}
const ZONE_LABELS_20=[];
for(let r=0;r<ZONE_SIZE;r++)for(let c=0;c<ZONE_SIZE;c++)ZONE_LABELS_20.push(zoneLabel20(r,c));

function isStrikeCell(flatIdx){
  const r=Math.floor(flatIdx/ZONE_SIZE),c=flatIdx%ZONE_SIZE;
  return r>=SZ_R0&&r<=SZ_R1&&c>=SZ_C0&&c<=SZ_C1;
}

/* ── Canvas drawing for the 20×20 zone grid ──────────────── */
// px lets callers render the same grid at other sizes (live pad = 240px)
function drawZoneCanvas(canvas, activeIdx, px){
  const P=px||GRID_PX, CELL=P/ZONE_SIZE, s=P/GRID_PX;
  const ctx=canvas.getContext('2d');
  const dpr=window.devicePixelRatio||1;
  canvas.width=P*dpr;
  canvas.height=P*dpr;
  ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,P,P);

  // Ball zone background (with safe roundRect)
  ctx.fillStyle='rgba(30,50,80,0.45)';
  ctx.beginPath();
  if(ctx.roundRect){ctx.roundRect(0,0,P,P,4*s);}
  else{ctx.rect(0,0,P,P);}
  ctx.fill();

  // Strike zone box
  const szX=SZ_C0*CELL, szY=SZ_R0*CELL;
  const szW=(SZ_C1-SZ_C0+1)*CELL, szH=(SZ_R1-SZ_R0+1)*CELL;
  ctx.fillStyle='rgba(16,77,151,0.15)';
  ctx.fillRect(szX,szY,szW,szH);
  ctx.strokeStyle='rgba(100,150,230,0.5)';
  ctx.lineWidth=1.2*s;
  ctx.strokeRect(szX,szY,szW,szH);

  // Strike zone 3×3 thirds grid lines
  ctx.strokeStyle='rgba(100,150,230,0.18)';
  ctx.lineWidth=0.6*s;
  for(let i=1;i<3;i++){
    const xLine=szX+(szW/3)*i;
    ctx.beginPath();ctx.moveTo(xLine,szY);ctx.lineTo(xLine,szY+szH);ctx.stroke();
    const yLine=szY+(szH/3)*i;
    ctx.beginPath();ctx.moveTo(szX,yLine);ctx.lineTo(szX+szW,yLine);ctx.stroke();
  }

  // Labels
  ctx.font=(6*s)+'px "IBM Plex Mono",monospace';
  ctx.textAlign='center';
  ctx.fillStyle='rgba(122,150,184,0.45)';
  ctx.fillText('IN',szX-1*s,P-1*s);
  ctx.fillText('OUT',szX+szW+1*s,P-1*s);
  ctx.fillText('HIGH',P/2,szY-2*s);
  ctx.fillText('LOW',P/2,szY+szH+8*s);

  // Active cell highlight
  if(activeIdx>=0){
    const ar=Math.floor(activeIdx/ZONE_SIZE),ac=activeIdx%ZONE_SIZE;
    const inStrike=isStrikeCell(activeIdx);
    ctx.fillStyle=inStrike?'rgba(46,125,50,0.6)':'rgba(198,40,40,0.6)';
    ctx.fillRect(ac*CELL,ar*CELL,CELL,CELL);
  }
}

/* ── Zone grid HTML — canvas-based with drag dot ─────────── */
function zoneGridHtml(idx){
  return `<div class="zone-grid" id="zone-${idx}" data-pitch-idx="${idx}">
    <canvas id="zoneCanvas-${idx}" width="120" height="120"></canvas>
    <div class="zone-drag-dot" id="zoneDot-${idx}"></div>
    <span class="zone-drag-hint" id="zoneHint-${idx}">tap or drag</span>
  </div>`;
}

// Store active zone per pitch (flat index 0-399, or -1 if none)
const zoneSelections=[];

function initZoneCanvas(idx){
  const canvas=document.getElementById('zoneCanvas-'+idx);
  if(!canvas)return;
  const activeIdx=zoneSelections[idx]!==undefined?zoneSelections[idx]:-1;
  drawZoneCanvas(canvas, activeIdx);
}

/* ── Pixel position → flat zone index ────────────────────── */
function pixelToZone(grid, clientX, clientY){
  const rect=grid.getBoundingClientRect();
  const x=clientX-rect.left, y=clientY-rect.top;
  let col=Math.floor(x/((rect.width)/ZONE_SIZE));
  let row=Math.floor(y/((rect.height)/ZONE_SIZE));
  col=Math.max(0,Math.min(col,ZONE_SIZE-1));
  row=Math.max(0,Math.min(row,ZONE_SIZE-1));
  return row*ZONE_SIZE+col;
}

/* ── Flat index → pixel center within grid ───────────────── */
function zoneCellCenter(flatIdx){
  const row=Math.floor(flatIdx/ZONE_SIZE),col=flatIdx%ZONE_SIZE;
  return{x:(col+0.5)*CELL_PX, y:(row+0.5)*CELL_PX};
}

function selectZone(pitchIdx, flatIdx){
  const wasActive=zoneSelections[pitchIdx]===flatIdx;
  if(wasActive){
    // Clear selection
    zoneSelections[pitchIdx]=-1;
    marks[pitchIdx]=null;
    const dot=document.getElementById('zoneDot-'+pitchIdx);
    const hint=document.getElementById('zoneHint-'+pitchIdx);
    if(dot)dot.classList.remove('visible','exec','notexec');
    if(hint)hint.style.display='';
  } else {
    zoneSelections[pitchIdx]=flatIdx;
    const inStrike=isStrikeCell(flatIdx);
    marks[pitchIdx]=inStrike?'exec':'notexec';
    positionDotOnZone(pitchIdx, flatIdx);
  }
  initZoneCanvas(pitchIdx);
  updateRow(pitchIdx);
  updateSummary();
  updateLocationMap();
}

function positionDotOnZone(pitchIdx, flatIdx){
  const dot=document.getElementById('zoneDot-'+pitchIdx);
  const hint=document.getElementById('zoneHint-'+pitchIdx);
  if(!dot)return;
  const{x,y}=zoneCellCenter(flatIdx);
  dot.style.left=x+'px';
  dot.style.top=y+'px';
  dot.classList.add('visible');
  dot.classList.remove('exec','notexec');
  if(marks[pitchIdx]==='exec')dot.classList.add('exec');
  else if(marks[pitchIdx]==='notexec')dot.classList.add('notexec');
  if(hint)hint.style.display='none';
}

/* ── Tap / click on the grid canvas ──────────────────────── */

/* ── Drag handling for zone dots ─────────────────────────── */
(function initZoneDrag(){
  let dragState=null;

  function startDrag(e,dot){
    const pitchIdx=parseInt(dot.id.replace('zoneDot-',''));
    const grid=document.getElementById('zone-'+pitchIdx);
    if(!grid)return;
    e.preventDefault();
    e.stopPropagation();
    dot.classList.add('dragging');
    const touch=e.touches?e.touches[0]:e;
    dragState={pitchIdx,grid,dot};
  }

  function moveDrag(e){
    if(!dragState)return;
    e.preventDefault();
    const touch=e.touches?e.touches[0]:e;
    const{grid,dot,pitchIdx}=dragState;
    const gridRect=grid.getBoundingClientRect();
    let x=touch.clientX-gridRect.left;
    let y=touch.clientY-gridRect.top;
    x=Math.max(0,Math.min(x,gridRect.width));
    y=Math.max(0,Math.min(y,gridRect.height));
    dot.style.left=x+'px';
    dot.style.top=y+'px';
  }

  function endDrag(e){
    if(!dragState)return;
    const{pitchIdx,grid,dot}=dragState;
    dot.classList.remove('dragging');
    const touch=e.changedTouches?e.changedTouches[0]:e;
    const flatIdx=pixelToZone(grid,touch.clientX,touch.clientY);
    zoneSelections[pitchIdx]=flatIdx;
    const inStrike=isStrikeCell(flatIdx);
    marks[pitchIdx]=inStrike?'exec':'notexec';
    positionDotOnZone(pitchIdx, flatIdx);
    initZoneCanvas(pitchIdx);
    updateRow(pitchIdx);
    updateSummary();
    updateLocationMap();
    dragState=null;
  }

  document.addEventListener('mousedown',function(e){
    if(e.target.classList.contains('zone-drag-dot'))startDrag(e,e.target);
  });
  document.addEventListener('mousemove',function(e){moveDrag(e);});
  document.addEventListener('mouseup',function(e){endDrag(e);});

  document.addEventListener('touchstart',function(e){
    if(e.target.classList.contains('zone-drag-dot'))startDrag(e,e.target);
  },{passive:false});
  document.addEventListener('touchmove',function(e){
    if(dragState)moveDrag(e);
  },{passive:false});
  document.addEventListener('touchend',function(e){endDrag(e);});

  // Grid tap/click — delegate from zone-grid elements
  document.addEventListener('click',function(e){
    const grid=e.target.closest('.zone-grid');
    if(!grid||e.target.classList.contains('zone-drag-dot'))return;
    const idx=parseInt(grid.dataset.pitchIdx);
    if(isNaN(idx))return;
    const flatIdx=pixelToZone(grid,e.clientX,e.clientY);
    selectZone(idx, flatIdx);
  });
})();

function getZone(pitchIdx){
  const fi=zoneSelections[pitchIdx];
  return(fi!==undefined&&fi>=0)?ZONE_LABELS_20[fi]:'';
}

function getZoneFlatIdx(pitchIdx){
  const fi=zoneSelections[pitchIdx];
  return(fi!==undefined&&fi>=0)?fi:-1;
}

/* =========================================================
   LOCATION MAP — SVG pitch plot
   Maps the 20×20 grid onto a pitcher's-view strike zone diagram.
   Each cell center is a candidate dot position.
   ========================================================= */
let mapFilter='All';

function setMapFilter(f){
  mapFilter=f;
  ['All','FA','CH','BB'].forEach(k=>{
    const btn=document.getElementById('mapFilter'+k);
    if(btn)btn.classList.toggle('active',k===f);
  });
  drawLocationMap();
}

// SVG layout constants
const MAP_W=220,MAP_H=240;
const SZ_X1=55,SZ_Y1=40,SZ_X2=165,SZ_Y2=185; // strike zone rect
const CELL_W=(SZ_X2-SZ_X1)/3,CELL_H=(SZ_Y2-SZ_Y1)/3;
// Ball zone extends one cell width outside each edge
const BALL_PAD_X=CELL_W,BALL_PAD_Y=CELL_H;

// Full plotting area covers the ball zone background rect
const PLOT_X0=SZ_X1-BALL_PAD_X, PLOT_Y0=SZ_Y1-BALL_PAD_Y;
const PLOT_W=(SZ_X2-SZ_X1)+2*BALL_PAD_X, PLOT_H=(SZ_Y2-SZ_Y1)+2*BALL_PAD_Y;

function zoneCenterXY(flatIdx){
  const row=Math.floor(flatIdx/ZONE_SIZE),col=flatIdx%ZONE_SIZE;
  // Linear mapping: col 0..19 → PLOT_X0..PLOT_X0+PLOT_W, row 0..19 → PLOT_Y0..PLOT_Y0+PLOT_H
  const x=PLOT_X0+(col+0.5)*(PLOT_W/ZONE_SIZE);
  const y=PLOT_Y0+(row+0.5)*(PLOT_H/ZONE_SIZE);
  return{x,y};
}

// Single source of truth for pitch-type colors: read the CSS custom properties
// so the location map, legend, trend charts, summary chips and config panel all
// agree (FA red, CH amber, BB blue). Fallbacks match the :root defaults in case
// getComputedStyle is unavailable.
function cssVar(name,fallback){
  try{var v=getComputedStyle(document.documentElement).getPropertyValue(name).trim();return v||fallback;}catch(e){return fallback;}
}
const PITCH_COLORS={FA:cssVar('--fastball','#e84545'),CH:cssVar('--changeup','#f59e0b'),BB:cssVar('--breaking-ball','#3b82f6')};

// Reverse lookup: zone label string → flat 0-399 index
const ZONE_LABEL_TO_IDX={};
ZONE_LABELS_20.forEach((label,idx)=>{ZONE_LABEL_TO_IDX[label]=idx;});

/* ── Backward compatibility: map old 5×5 labels to nearest 20×20 index ── */
(function buildLegacyMap(){
  const oldLabels5x5=[];
  for(let r=0;r<5;r++)for(let c=0;c<5;c++){
    const inS=(r>=1&&r<=3&&c>=1&&c<=3);
    const rT=['HB','U','M','L','LB'][r], cT=['FI','In','Mid','Out','FO'][c];
    let lab;
    if(inS){lab=['U','M','L'][r-1]+['In','Mid','Out'][c-1];}
    else{lab='B-'+rT+cT;}
    oldLabels5x5.push({label:lab,r5:r,c5:c});
  }
  // Map each old 5×5 cell center to the nearest 20×20 cell
  oldLabels5x5.forEach(({label,r5,c5})=>{
    // Old 5×5 cell centers: for cols, strike was 1-3 of 5, ball at 0/4
    // Map to 20×20 proportionally: col fraction = (c5+0.5)/5, row fraction = (r5+0.5)/5
    const newCol=Math.round((c5+0.5)/5*ZONE_SIZE-0.5);
    const newRow=Math.round((r5+0.5)/5*ZONE_SIZE-0.5);
    const clampC=Math.max(0,Math.min(newCol,ZONE_SIZE-1));
    const clampR=Math.max(0,Math.min(newRow,ZONE_SIZE-1));
    if(!(label in ZONE_LABEL_TO_IDX)){
      ZONE_LABEL_TO_IDX[label]=clampR*ZONE_SIZE+clampC;
    }
  });
})();

/* ── Shared SVG map renderer ────────────────────────────────
   pitchArray: [{ flatIdx, type, result }]
     result: 'exec' | 'notexec' | 'Executed' | 'Not Executed' | ''
   svgEl: the <svg> DOM element to write into
   emptyMsg: string shown when pitchArray is empty
   ──────────────────────────────────────────────────────── */
function drawSvgMap(svgEl, pitchArray, emptyMsg){
  if(!svgEl)return;

  let s='';
  s+=`<rect width="${MAP_W}" height="${MAP_H}" fill="none"/>`;

  // Home plate
  const px=MAP_W/2,py=MAP_H-14;
  s+=`<polygon points="${px-14},${py} ${px+14},${py} ${px+14},${py+10} ${px},${py+18} ${px-14},${py+10}" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.2)" stroke-width="1"/>`;

  // Ball zone background
  s+=`<rect x="${SZ_X1-BALL_PAD_X}" y="${SZ_Y1-BALL_PAD_Y}" width="${(SZ_X2-SZ_X1)+2*BALL_PAD_X}" height="${(SZ_Y2-SZ_Y1)+2*BALL_PAD_Y}" rx="6" fill="rgba(30,50,80,0.4)" stroke="rgba(122,150,184,0.15)" stroke-width="1"/>`;

  // Strike zone box
  s+=`<rect x="${SZ_X1}" y="${SZ_Y1}" width="${SZ_X2-SZ_X1}" height="${SZ_Y2-SZ_Y1}" rx="2" fill="rgba(16,77,151,0.12)" stroke="rgba(100,150,230,0.5)" stroke-width="1.5"/>`;

  // Strike zone grid lines
  for(let i=1;i<3;i++){
    s+=`<line x1="${SZ_X1+CELL_W*i}" y1="${SZ_Y1}" x2="${SZ_X1+CELL_W*i}" y2="${SZ_Y2}" stroke="rgba(100,150,230,0.2)" stroke-width="0.8"/>`;
    s+=`<line x1="${SZ_X1}" y1="${SZ_Y1+CELL_H*i}" x2="${SZ_X2}" y2="${SZ_Y1+CELL_H*i}" stroke="rgba(100,150,230,0.2)" stroke-width="0.8"/>`;
  }

  // Axis labels
  s+=`<text x="${SZ_X1-2}" y="${SZ_Y2+16}" font-family="IBM Plex Mono,monospace" font-size="7" fill="rgba(122,150,184,0.5)" text-anchor="middle">IN</text>`;
  s+=`<text x="${SZ_X2+2}" y="${SZ_Y2+16}" font-family="IBM Plex Mono,monospace" font-size="7" fill="rgba(122,150,184,0.5)" text-anchor="middle">OUT</text>`;
  s+=`<text x="${MAP_W/2}" y="${SZ_Y1-6}" font-family="IBM Plex Mono,monospace" font-size="7" fill="rgba(122,150,184,0.5)" text-anchor="middle">HIGH</text>`;
  s+=`<text x="${MAP_W/2}" y="${SZ_Y2+16}" font-family="IBM Plex Mono,monospace" font-size="7" fill="rgba(122,150,184,0.5)" text-anchor="middle">LOW</text>`;

  // Dots
  const cellCounts={},cellIdx={};
  pitchArray.forEach(t=>{cellCounts[t.flatIdx]=(cellCounts[t.flatIdx]||0);});

  pitchArray.forEach(t=>{
    const {x,y}=zoneCenterXY(t.flatIdx);
    const slot=cellIdx[t.flatIdx]||0;
    cellIdx[t.flatIdx]=slot+1;
    cellCounts[t.flatIdx]=(cellCounts[t.flatIdx]||0)+1;

    const angle=slot*(Math.PI*0.7);
    const radius=slot===0?0:Math.min(slot*3,8);
    const dx=radius*Math.cos(angle),dy=radius*Math.sin(angle);

    const col=PITCH_COLORS[t.type]||'#94a3b8';
    const r=4.5;

    s+=`<circle cx="${x+dx}" cy="${y+dy}" r="${r+1.2}" fill="rgba(0,0,0,0.35)"/>`;
    s+=`<circle cx="${x+dx}" cy="${y+dy}" r="${r}" fill="${col}" opacity="0.85"/>`;
    s+=`<circle cx="${x+dx}" cy="${y+dy}" r="1.5" fill="rgba(255,255,255,0.6)"/>`;
  });

  // Legend
  const legY=MAP_H-4;
  let legX=14;
  [['FA',PITCH_COLORS.FA],['CH',PITCH_COLORS.CH],['BB',PITCH_COLORS.BB]].forEach(([label,col])=>{
    s+=`<circle cx="${legX}" cy="${legY}" r="4" fill="${col}" opacity="0.85"/>`;
    s+=`<text x="${legX+6}" y="${legY+3}" font-family="IBM Plex Mono,monospace" font-size="7" fill="rgba(180,200,220,0.7)">${label}</text>`;
    legX+=30;
  });

  if(pitchArray.length===0){
    const msg=emptyMsg||'No location data';
    s+=`<text x="${MAP_W/2}" y="${MAP_H/2}" font-family="IBM Plex Mono,monospace" font-size="8" fill="rgba(122,150,184,0.4)" text-anchor="middle">${msg}</text>`;
  }

  svgEl.innerHTML=s;
}

function drawLocationMap(){
  const svg=document.getElementById('locationMapSvg');
  if(!svg)return;
  const tagged=[];
  pitches.forEach((p,i)=>{
    const fi=getZoneFlatIdx(i);
    if(fi<0)return;
    if(mapFilter!=='All'&&p.type!==mapFilter)return;
    tagged.push({flatIdx:fi,type:p.type,result:marks[i]==='exec'?'exec':marks[i]==='notexec'?'notexec':''});
  });
  drawSvgMap(svg,tagged,'Tag zones in the pitch list');
}

function updateLocationMap(){
  // Show panel once at least one zone is tagged
  const anyTagged=pitches.some((_,i)=>getZoneFlatIdx(i)>=0);
  const panel=document.getElementById('locationMapPanel');
  if(panel)panel.style.display=anyTagged?'block':'none';
  drawLocationMap();
}

function getVelo(pitchIdx){
  const el=document.getElementById('velo-'+pitchIdx);
  return el?el.value.trim():'';
}

function saveFieldState(){
  return pitches.map((_,i)=>({velo:getVelo(i),zoneIdx:zoneSelections[i]!==undefined?zoneSelections[i]:-1}));
}

// Restores a zone cell visually without touching marks[] — used when re-rendering
function restoreZoneCell(pitchIdx, zoneIdx){
  if(zoneIdx<0)return;
  zoneSelections[pitchIdx]=zoneIdx;
  requestAnimationFrame(()=>{
    initZoneCanvas(pitchIdx);
    positionDotOnZone(pitchIdx, zoneIdx);
  });
}

function restoreFieldState(saved){
  saved.forEach((s,i)=>{
    const veloEl=document.getElementById('velo-'+i);
    if(veloEl&&s.velo)veloEl.value=s.velo;
    if(s.zoneIdx>=0)restoreZoneCell(i,s.zoneIdx);
  });
}

/* One row of the pitch table (v35: type + delivery are direct-pick chips —
   one tap, no cycling; in live-pad modes the # opens pad editing). */
function rowHtml(i){
  const p=pitches[i];
  const eC=marks[i]==='exec'?' executed':'',nC=marks[i]==='notexec'?' not-executed':'';
  const padOn=typeof lpPadActive==='function'&&lpPadActive();
  const numCell=padOn
    ?`<span class="pitch-num lp-editable" onclick="lpEditPitch(${i})" title="Edit this pitch in the pad">${i+1}</span>`
    :`<span class="pitch-num">${i+1}</span>`;
  const typeChips=PITCH_TYPES.map(t=>
    `<button class="pchip t-${t.cls}${p.type===t.type?' on':''}" onclick="setPitchType(${i},'${t.type}')">${t.type}</button>`).join('');
  const delChips=DELIVERIES.map(d=>
    `<button class="pchip d-${d.toLowerCase()}${p.delivery===d?' on':''}" onclick="setPitchDelivery(${i},'${d}')">${d==='Stretch'?'STR':'WND'}</button>`).join('');
  return `<td>${numCell}</td>`+
    `<td><div class="pchip-group">${typeChips}</div></td>`+
    `<td><div class="pchip-group">${delChips}</div></td>`+
    `<td><div class="velo-zone-cell"><input class="velo-input" type="number" id="velo-${i}" placeholder="MPH" min="40" max="110" step="1">${zoneGridHtml(i)}</div></td>`+
    `<td><div class="exec-cell"><button class="exec-btn${eC}" onclick="toggleMark(${i},'exec')">${marks[i]==='exec'?'✓':''}</button></div></td>`+
    `<td><div class="exec-cell"><button class="exec-btn${nC}" onclick="toggleMark(${i},'notexec')">${marks[i]==='notexec'?'✗':''}</button></div></td>`+
    `<td><div class="exec-cell"><button class="del-btn" onclick="deletePitch(${i})" title="Remove pitch">✕</button></div></td>`;
}

function render(anim){
  const body=document.getElementById('pitchBody');
  body.innerHTML='';
  pitches.forEach((p,i)=>{
    if(zoneSelections[i]===undefined)zoneSelections[i]=-1;
    const tr=document.createElement('tr');
    if(anim){tr.classList.add('shuffled');tr.style.animationDelay=`${i*0.02}s`;}
    tr.innerHTML=rowHtml(i);
    body.appendChild(tr);
  });
  // Initialize all zone canvases after DOM is built
  requestAnimationFrame(()=>{
    pitches.forEach((_,i)=>{
      initZoneCanvas(i);
      if(zoneSelections[i]>=0)positionDotOnZone(i,zoneSelections[i]);
    });
  });
  updateStatsBar();
  updateSummary();
}

function updateRow(i){
  const r=document.getElementById('pitchBody').rows[i];
  if(!r)return;
  const e=r.cells[4].querySelector('.exec-btn'),n=r.cells[5].querySelector('.exec-btn');
  e.className='exec-btn'+(marks[i]==='exec'?' executed':'');
  e.textContent=marks[i]==='exec'?'✓':'';
  n.className='exec-btn'+(marks[i]==='notexec'?' not-executed':'');
  n.textContent=marks[i]==='notexec'?'✗':'';
  // Redraw canvas and update dot color
  initZoneCanvas(i);
  if(zoneSelections[i]>=0)positionDotOnZone(i,zoneSelections[i]);
}
function getTypeStats(t){let e=0,n=0;pitches.forEach((p,i)=>{if(p.type===t){if(marks[i]==='exec')e++;if(marks[i]==='notexec')n++;}});const tot=e+n,c=pitches.filter(p=>p.type===t).length;return{exec:e,notexec:n,total:tot,count:c,rate:tot>0?Math.round(e/tot*100)+'%':'—'};}

function updateSummary(){
  const e=marks.filter(m=>m==='exec').length,n=marks.filter(m=>m==='notexec').length,t=e+n;
  document.getElementById('sumExec').textContent=e;
  document.getElementById('sumNotExec').textContent=n;
  document.getElementById('sumRate').textContent=t>0?Math.round(e/t*100)+'%':'—';
  const c=document.getElementById('summaryByType');
  const uBar=document.getElementById('summaryUsageBar');
  const eByType=document.getElementById('execByType');
  const tc=[{name:'FA',color:'var(--fastball)'},{name:'CH',color:'var(--changeup)'},{name:'BB',color:'var(--breaking-ball)'}];
  const at=tc.filter(x=>pitches.some(p=>p.type===x.name));
  if(!at.length){c.innerHTML='';uBar.style.display='none';uBar.innerHTML='';eByType.style.display='none';eByType.innerHTML='';return;}
  // Pitch Usage section — name + count only, no execution data
  c.style.gridTemplateColumns=`repeat(${at.length},1fr)`;
  c.innerHTML=at.map(x=>{
    const cnt=pitches.filter(p=>p.type===x.name).length;
    return`<div class="type-stat"><div class="type-stat-header"><span class="pip" style="background:${x.color}"></span><span class="type-name">${x.name}</span></div><div class="type-stat-rate" style="color:${x.color}">${cnt}</div><div class="type-stat-detail">pitches</div></div>`;
  }).join('');
  // Usage bar
  const fa=pitches.filter(p=>p.type==='FA').length,cb=pitches.filter(p=>p.type==='BB').length,ch=pitches.filter(p=>p.type==='CH').length;
  uBar.innerHTML=buildUsageBar(fa,cb,ch);uBar.style.display='block';
  // Execution by type section
  eByType.style.gridTemplateColumns=`repeat(${at.length},1fr)`;
  eByType.style.display='grid';
  eByType.innerHTML=at.map(x=>{
    const s=getTypeStats(x.name);
    return`<div class="exec-type-col"><div class="exec-type-label"><span class="pip" style="background:${x.color}"></span>${x.name}</div><div class="exec-type-rate">${s.rate}</div><div class="exec-type-detail">${s.exec}✓ &nbsp;${s.notexec}✗ &nbsp;of ${s.count}</div></div>`;
  }).join('');
}

function updateStatsBar(){const b=document.getElementById('statsBar');const fb=pitches.filter(p=>p.type==='FA').length,ch=pitches.filter(p=>p.type==='CH').length,cb=pitches.filter(p=>p.type==='BB').length,st=pitches.filter(p=>p.delivery==='Stretch').length,wu=pitches.filter(p=>p.delivery==='Windup').length;b.innerHTML=(fb?`<div class="stat-chip"><span class="dot" style="background:var(--fastball)"></span>FA <span class="val">${fb}</span></div>`:'')+(ch?`<div class="stat-chip"><span class="dot" style="background:var(--changeup)"></span>CH <span class="val">${ch}</span></div>`:'')+(cb?`<div class="stat-chip"><span class="dot" style="background:var(--breaking-ball)"></span>BB <span class="val">${cb}</span></div>`:'')+(st?`<div class="stat-chip"><span class="dot" style="background:var(--stretch)"></span>Stretch <span class="val">${st}</span></div>`:'')+(wu?`<div class="stat-chip"><span class="dot" style="background:var(--windup)"></span>Windup <span class="val">${wu}</span></div>`:'')+`<div class="stat-chip">Total <span class="val">${pitches.length}</span></div>`;}

/* ========== EDIT PITCH INLINE ========== */
const PITCH_TYPES=[{type:'FA',cls:'fastball'},{type:'CH',cls:'changeup'},{type:'BB',cls:'breaking-ball'}];
const DELIVERIES=['Stretch','Windup'];

/* v35 — direct-pick edits rebuild ONE row (velo preserved) instead of the
   whole table; replaces the old cyclePitchType/cycleDelivery tap-cycling. */
function rebuildRow(i){
  const body=document.getElementById('pitchBody');
  const tr=body&&body.rows[i];
  if(!tr)return;
  const velo=getVelo(i);
  tr.innerHTML=rowHtml(i);
  if(velo){const v=document.getElementById('velo-'+i);if(v)v.value=velo;}
  requestAnimationFrame(()=>{
    initZoneCanvas(i);
    if(zoneSelections[i]>=0)positionDotOnZone(i,zoneSelections[i]);
  });
}

function setPitchType(i,t){
  if(pitches[i].type===t)return;
  const pt=PITCH_TYPES.find(x=>x.type===t);
  pitches[i].type=pt.type;pitches[i].cls=pt.cls;
  rebuildRow(i);
  updateStatsBar();updateSummary();updateLocationMap();
}

function setPitchDelivery(i,d){
  if(pitches[i].delivery===d)return;
  pitches[i].delivery=d;
  rebuildRow(i);
  updateStatsBar();updateSummary();
}

/* =========================================================
   v35 LIVE PAD (Decision 4A) — Dynamic + Game tracking.
   A fixed entry pad drives the session: type + delivery are
   sticky direct-picks, one tap on the big zone logs location
   + result + advances. The table below is the editable log —
   tapping a row's # loads that pitch into the pad for fixes.
   Writes the SAME pitches/marks/zoneSelections arrays as the
   table, so maps, heat maps and saves are unchanged.
   ========================================================= */
const LP_PX=240; // pad zone canvas size (same 20×20 grid as row grids)
let lpType='FA',lpDel='Stretch',lpEditIdx=null;

function lpPadActive(){return sessionActive&&getSessionType()!=='preset';}

function lpSync(){
  const pad=document.getElementById('livePad');
  if(!pad)return;
  const on=lpPadActive();
  pad.style.display=on?'block':'none';
  if(on){lpEditIdx=null;lpPaint();lpDrawZone(-1);lpHeader();}
}

function lpDrawZone(activeIdx){
  const c=document.getElementById('lpZoneCanvas');
  if(c)drawZoneCanvas(c,activeIdx,LP_PX);
}

function lpPaint(){
  const t=lpEditIdx!=null?pitches[lpEditIdx].type:lpType;
  const d=lpEditIdx!=null?pitches[lpEditIdx].delivery:lpDel;
  PITCH_TYPES.forEach(x=>{
    const b=document.getElementById('lpType'+x.type);
    if(b)b.classList.toggle('on',x.type===t);
  });
  const s=document.getElementById('lpDelS'),w=document.getElementById('lpDelW');
  if(s)s.classList.toggle('on',d==='Stretch');
  if(w)w.classList.toggle('on',d==='Windup');
}

function lpHeader(){
  const title=document.getElementById('lpTitle'),sub=document.getElementById('lpSub');
  const undo=document.getElementById('lpUndo'),done=document.getElementById('lpDone');
  if(!title)return;
  if(lpEditIdx!=null){
    title.textContent='EDITING PITCH '+(lpEditIdx+1);
    sub.textContent='tap zone or result to correct';
    undo.style.display='none';done.style.display='';
  }else{
    title.textContent='PITCH '+(pitches.length+1);
    sub.textContent=pitches.length?pitches.length+' tracked':'tap the zone to log the first pitch';
    undo.style.display=pitches.length?'':'none';done.style.display='none';
  }
}

function lpSetType(t){
  if(lpEditIdx!=null){setPitchType(lpEditIdx,t);}
  else lpType=t;
  lpPaint();
}
function lpSetDel(d){
  if(lpEditIdx!=null){setPitchDelivery(lpEditIdx,d);}
  else lpDel=d;
  lpPaint();
}

function lpZoneTap(flatIdx){
  const mark=isStrikeCell(flatIdx)?'exec':'notexec';
  if(lpEditIdx!=null){
    const i=lpEditIdx;
    zoneSelections[i]=flatIdx;marks[i]=mark;
    rebuildRow(i);updateSummary();updateLocationMap();
    lpFlash(flatIdx);lpExitEdit();
  }else{
    lpCommit(flatIdx,mark);
  }
}

function lpLogResult(mark){
  if(lpEditIdx!=null){
    const i=lpEditIdx;
    marks[i]=mark;
    rebuildRow(i);updateSummary();updateLocationMap();
    lpExitEdit();
  }else{
    lpCommit(-1,mark);
  }
}

function lpCommit(zoneIdx,mark){
  const pt=PITCH_TYPES.find(x=>x.type===lpType);
  pitches.push({type:pt.type,cls:pt.cls,delivery:lpDel});
  marks.push(mark);
  zoneSelections.push(zoneIdx);
  const i=pitches.length-1;
  const body=document.getElementById('pitchBody');
  const tr=document.createElement('tr');
  tr.innerHTML=rowHtml(i);
  body.appendChild(tr);
  const lpV=document.getElementById('lpVelo');
  const v=lpV?lpV.value.trim():'';
  if(v){const vEl=document.getElementById('velo-'+i);if(vEl)vEl.value=v;}
  if(lpV)lpV.value='';
  requestAnimationFrame(()=>{
    initZoneCanvas(i);
    if(zoneIdx>=0)positionDotOnZone(i,zoneIdx);
  });
  updateStatsBar();updateSummary();updateLocationMap();
  lpHeader();
  if(zoneIdx>=0)lpFlash(zoneIdx);
}

// brief confirmation: show the logged cell on the pad, then clear for the next pitch
let lpFlashTimer=null;
function lpFlash(flatIdx){
  lpDrawZone(flatIdx);
  clearTimeout(lpFlashTimer);
  lpFlashTimer=setTimeout(()=>{if(lpEditIdx==null)lpDrawZone(-1);},450);
}

function lpUndo(){
  if(!pitches.length)return;
  const i=pitches.length-1;
  const removed=pitches.pop();marks.pop();zoneSelections.pop();
  const body=document.getElementById('pitchBody');
  if(body.rows[i])body.deleteRow(i);
  updateStatsBar();updateSummary();updateLocationMap();
  lpHeader();
  showToast(removed.type+' #'+(i+1)+' removed');
}

function lpEditPitch(i){
  if(!lpPadActive())return;
  lpEditIdx=i;
  lpPaint();
  lpDrawZone(zoneSelections[i]>=0?zoneSelections[i]:-1);
  const lpV=document.getElementById('lpVelo');
  if(lpV)lpV.value=getVelo(i);
  const body=document.getElementById('pitchBody');
  for(const r of body.rows)r.classList.remove('lp-edit-row');
  if(body.rows[i])body.rows[i].classList.add('lp-edit-row');
  lpHeader();
  const pad=document.getElementById('livePad');
  if(pad)pad.scrollIntoView({behavior:'smooth',block:'nearest'});
}

function lpExitEdit(){
  if(lpEditIdx==null)return;
  const body=document.getElementById('pitchBody');
  for(const r of body.rows)r.classList.remove('lp-edit-row');
  lpEditIdx=null;
  const lpV=document.getElementById('lpVelo');
  if(lpV)lpV.value='';
  lpPaint();lpDrawZone(-1);lpHeader();
}

// pad wiring (elements exist from page load; taps use the shared pixelToZone)
(function initLivePad(){
  const grid=document.getElementById('lpZoneGrid');
  if(!grid)return;
  grid.addEventListener('click',function(e){
    lpZoneTap(pixelToZone(grid,e.clientX,e.clientY));
  });
  const lpV=document.getElementById('lpVelo');
  if(lpV)lpV.addEventListener('input',function(){
    // while editing, velo edits flow straight into the row's input
    if(lpEditIdx!=null){const vEl=document.getElementById('velo-'+lpEditIdx);if(vEl)vEl.value=lpV.value;}
  });
})();

/* ========== DELETE PITCH ========== */
function deletePitch(i){
  // Live-pad modes may delete down to zero; preset keeps its scripted table
  if(pitches.length<=1&&!lpPadActive()){showToast('Cannot delete the last pitch');return;}
  if(typeof lpEditIdx!=='undefined'&&lpEditIdx!=null)lpExitEdit();
  const saved=saveFieldState();
  const removed=pitches[i];
  pitches.splice(i,1);
  marks.splice(i,1);
  zoneSelections.splice(i,1);
  saved.splice(i,1);
  render(false);
  restoreFieldState(saved);
  showToast(removed.type+' '+removed.delivery+' removed');
}

/* ========== ADD PITCH (preset mode only — live-pad modes create pitches
   directly from the pad) ========== */
function addPitch(){
  const saved=saveFieldState();
  const typeVal=document.getElementById('addPitchType').value.split('|');
  const delivery=document.getElementById('addPitchDelivery').value;
  const newPitch={type:typeVal[0],cls:typeVal[1],delivery:delivery};
  pitches.push(newPitch);
  marks.push(null);
  zoneSelections.push(-1);
  render(false);
  restoreFieldState(saved);
  const body=document.getElementById('pitchBody');
  const lastRow=body.rows[body.rows.length-1];
  if(lastRow)lastRow.scrollIntoView({behavior:'smooth',block:'nearest'});
  showToast(typeVal[0]+' '+delivery+' added (#'+pitches.length+')');
}

/* ========== CLEAR BLANKS ========== */
/* Removes consecutive blank pitches from the end of the session.
   A pitch is "blank" if it has no velo, no zone, and no execution mark. */
function clearBlanks(){
  if(!sessionActive||pitches.length<=1)return;
  // Read current field state so we can check velo from DOM inputs
  const saved=saveFieldState();
  // Walk backward from the end and count how many trailing blanks there are
  let trimCount=0;
  for(let i=pitches.length-1;i>=1;i--){ // always keep at least 1 pitch
    const hasVelo=saved[i]&&saved[i].velo&&saved[i].velo!=='';
    const hasZone=zoneSelections[i]>=0;
    const hasMark=marks[i]!==null;
    if(!hasVelo&&!hasZone&&!hasMark){
      trimCount++;
    } else {
      break; // stop at first non-blank from the end
    }
  }
  if(trimCount===0){showToast('No blank pitches at end');return;}
  // Remove the trailing blanks
  pitches.splice(pitches.length-trimCount,trimCount);
  marks.splice(marks.length-trimCount,trimCount);
  zoneSelections.splice(zoneSelections.length-trimCount,trimCount);
  saved.splice(saved.length-trimCount,trimCount);
  render(false);
  restoreFieldState(saved);
  updateLocationMap();
  showToast(trimCount+' blank pitch'+(trimCount>1?'es':'')+' cleared');
}

/* ========== LOCAL EXPORTS ========== */
function getSessionData(){const pitcher=document.getElementById('pitcher').value||'',date=document.getElementById('date').value||'';const _stMap={preset:'Preset Bullpen',dynamic:'Dynamic Bullpen',game:'Game'};const session=_stMap[getSessionType()]||getSessionType();const rows=pitches.map((p,i)=>{return{number:i+1,pitchType:p.type,delivery:p.delivery,velo:getVelo(i),zone:getZone(i),result:marks[i]==='exec'?'Executed':marks[i]==='notexec'?'Not Executed':''};});const ex=marks.filter(m=>m==='exec').length,nx=marks.filter(m=>m==='notexec').length,tot=ex+nx;const byType={};['FA','CH','BB'].forEach(t=>{const s=getTypeStats(t);if(s.count>0)byType[t]={pitches:s.count,executed:s.exec,notExecuted:s.notexec,executionRate:s.rate};});return{pitcher,date,session,pitches:rows,summary:{executed:ex,notExecuted:nx,total:tot,executionRate:tot>0?Math.round(ex/tot*100)+'%':'N/A',byPitchType:byType}};}


/* ========== GOOGLE SHEETS — FETCH VIA GET ========== */
// JSONP caller — injects a <script> tag so CORS is never an issue,
// works identically on localhost, file://, and Netlify.
// Your GAS script already supports ?callback= via buildResponseWithCallback().
// timeoutMs defaults to 15s for fast calls; pass a higher value for fetch_all
// which reads every pitcher tab and can take 20-40s with a large roster.
function gasJsonp(baseUrl, params, timeoutMs) {
  // Shim: firebase-data-layer.js replaces window.gasJsonp at startup.
  // This handles only the startup race before that script executes.
  return new Promise(function(resolve, reject) {
    var tries = 0;
    (function wait() {
      if (window.__dataLayerReady) {
        window.__dataLayerReady.then(function() {
          resolve(window.gasJsonp(baseUrl, params, timeoutMs));
        });
      } else if (++tries > 200) {
        reject(new Error('Data layer failed to load — refresh the page'));
      } else {
        setTimeout(wait, 50);
      }
    })();
  });
}

// GAS call router — all actions use JSONP so we always get a real response back.
// For large export payloads the JSONP URL can exceed browser/GAS GET limits (~2 KB
// safe zone). doExport splits pitches into chunks of 10 to stay well under that limit.
// Timeout is 45s — GAS can be slow on cold starts, especially check_tab + export chains.
async function gasCall(baseUrl, params) {
  return gasJsonp(baseUrl, params, 45000);
}

function getSavedUrl(){try{return localStorage.getItem(SHEETS_URL_KEY)||DEFAULT_SHEETS_URL;}catch(e){return DEFAULT_SHEETS_URL;}}
function saveUrl(u){try{localStorage.setItem(SHEETS_URL_KEY,u);}catch(e){}}
function clearSheetsUrl(){try{localStorage.removeItem(SHEETS_URL_KEY);}catch(e){}document.getElementById('sheetsUrl').value='';showToast('Saved URL cleared');}

function openSheetsModal(){const pitcher=document.getElementById('pitcher').value.trim();if(!pitcher){showToast('Select a pitcher first');return;}if(!pitches.length){showToast('No pitches tracked yet');return;}document.getElementById('sheetsPitcher').value=pitcher;document.getElementById('sheetsPin').value='';const url=getSavedUrl();document.getElementById('sheetsUrl').value=url;const urlField=document.getElementById('sheetsUrlField');if(url&&url.startsWith('https://script.google.com/')){urlField.style.display='none';}else{urlField.style.display='block';}setSheetsStatus('','');resetSheetsActions();document.getElementById('sheetsModal').classList.add('open');}
function closeSheetsModal(){document.getElementById('sheetsModal').classList.remove('open');}
function setSheetsStatus(msg,type){const el=document.getElementById('sheetsStatus');el.className='modal-status'+(type?' '+type:'');el.innerHTML=msg;}
function resetSheetsActions(){document.getElementById('sheetsActions').innerHTML=`<button class="btn btn-cancel" onclick="closeSheetsModal()">Cancel</button><button class="btn btn-sheets-send" onclick="sendToSheets()"><svg class="icon"><use href="#i-save"/></svg> Save Session</button>`;}

async function sendToSheets(){
  const pin=document.getElementById('sheetsPin').value.trim();
  if(pin!=='2149'){setSheetsStatus('Incorrect PIN code','error');document.getElementById('sheetsPin').value='';document.getElementById('sheetsPin').focus();return;}
  const url=document.getElementById('sheetsUrl').value.trim();
  if(!url||!url.startsWith('https://script.google.com/')){setSheetsStatus('Enter a valid Apps Script URL starting with https://script.google.com/','error');return;}
  saveUrl(url);
  const data=getSessionData();
  const pitcher=data.pitcher.trim();
  if(!pitcher){setSheetsStatus('Pitcher name is required','error');return;}
  if(!data.date){setSheetsStatus('Date is required before exporting','error');document.getElementById('sheetsModal').classList.remove('open');document.getElementById('date').focus();showToast('Please fill in the date field');return;}

  setSheetsStatus('<span class="spinner"></span> Checking for pitcher tab...','info');

  try {
    const check = await gasCall(url, { action: 'check_tab', pitcher: pitcher });
    if (!check.success) { setSheetsStatus('Error: ' + check.error, 'error'); return; }

    if (!check.exists) {
      setSheetsStatus('No tab found for "<strong>' + pitcher + '</strong>". Would you like to create one?', 'confirm');
      document.getElementById('sheetsActions').innerHTML =
        '<button class="btn btn-cancel" onclick="closeSheetsModal()">Cancel</button>' +
        '<button class="btn btn-create-tab" onclick="createTabThenExport()">Create "' + pitcher + '" Tab</button>';
      return;
    }

    await doExport(url, data, pitcher);
  } catch (err) {
    setSheetsStatus('Connection failed: ' + err.message + '. Make sure you are running this file locally (not in claude.ai).', 'error');
  }
}

async function createTabThenExport(){
  const url=document.getElementById('sheetsUrl').value.trim();
  const data=getSessionData();
  const pitcher=data.pitcher.trim();
  setSheetsStatus('<span class="spinner"></span> Creating tab...','info');
  try {
    const result = await gasCall(url, { action: 'create_tab', pitcher: pitcher });
    if (!result.success) { setSheetsStatus('Error: ' + result.error, 'error'); return; }
    await doExport(url, data, pitcher);
  } catch (err) {
    setSheetsStatus('Failed: ' + err.message, 'error');
  }
}

async function doExport(url, data, pitcher){
  setSheetsStatus('<span class="spinner"></span> Sending ' + data.pitches.length + ' pitches...', 'info');
  try {
    const result = await gasCall(url, {
      action: 'export',
      pitcher: pitcher,
      date: data.date,
      session: data.session,
      pitches: JSON.stringify(data.pitches)
    });
    if (!result.success) {
      setSheetsStatus('Error: ' + result.error, 'error');
      return;
    }
    setSheetsStatus('✓ ' + result.rowsAdded + ' pitches saved for "' + pitcher + '"', 'success');
    document.getElementById('sheetsActions').innerHTML = '<button class="btn btn-cancel" onclick="closeSheetsModal()">Done</button>';
    showToast('Session saved!');
    refreshLeaderboardData();
  } catch (err) {
    setSheetsStatus('Export failed: ' + err.message, 'error');
  }
}

/* ========== VIEW TOGGLE (Waffle) & DATA VIEWER ========== */
let currentView='tracker';
let sheetData=[];
let sheetHeaders=[];
let filteredData=[];
let sortCol='';
let sortDir='desc';
let dataLoaded=false;
/* #1 — localStorage cache so the leaderboard paints instantly between visits.
   Keyed by season; refreshed in the background after a cache hit.
   v3 suffix: rows gained lastDate/prevExec (recency + trend, v39). */
function lbCacheKey(){const si=window.__seasonInfo;return 'lb_cache3_'+(si?si.selected:'cur');}
function readLbCache(){try{const r=localStorage.getItem(lbCacheKey());if(!r)return null;const o=JSON.parse(r);if(!o||!o.data)return null;return o;}catch(e){return null;}}
function writeLbCache(data,headers,prevSeason){try{localStorage.setItem(lbCacheKey(),JSON.stringify({data:data,headers:headers,prevSeason:!!prevSeason,ts:Date.now()}));}catch(e){}}
let activeFilters={};
let videoData=[];
let videoLoaded=false;

function toggleWaffleMenu(){
  document.getElementById('waffleMenu').classList.toggle('open');
}

document.addEventListener('click',e=>{
  if(!e.target.closest('.waffle-btn')&&!e.target.closest('.waffle-menu')){
    document.getElementById('waffleMenu').classList.remove('open');
  }
});

function switchView(view){
  document.getElementById('waffleMenu').classList.remove('open');
  const tracker=document.getElementById('viewTracker');
  const sheet=document.getElementById('viewSheet');
  const player=document.getElementById('viewPlayer');
  const players=document.getElementById('viewPlayers');
  const btn=document.getElementById('waffleBtn');

  // Hide all
  tracker.classList.add('hidden');
  sheet.classList.remove('active');
  if(player)player.classList.remove('active');
  if(players)players.classList.remove('active');

  var board=document.getElementById('viewBoard');
  if(board)board.classList.remove('active');

  // Update menu highlights (guarded — entries vary by version)
  ['wvTracker','wvSheet','wvPlayers','wvBoard'].forEach(function(id){
    var el=document.getElementById(id); if(el)el.classList.remove('active-view');
  });
  var wvPlayers=document.getElementById('wvPlayers');

  currentView=view;
  if(view==='tracker'){
    tracker.classList.remove('hidden');
    btn.classList.remove('active');
    document.getElementById('wvTracker').classList.add('active-view');
  }else if(view==='players'){
    if(players)players.classList.add('active');
    btn.classList.add('active');
    if(wvPlayers)wvPlayers.classList.add('active-view');
    if(typeof window.loadPlayersHub==='function')window.loadPlayersHub();
  }else if(view==='sheet'){
    sheet.classList.add('active');
    btn.classList.add('active');
    document.getElementById('wvSheet').classList.add('active-view');
    if(typeof setLbActivity==='function')setLbActivity('bullpen');
    if(!dataLoaded)fetchSheetData();
  }else if(view==='board'){
    if(board)board.classList.add('active');
    btn.classList.add('active');
    var wvB=document.getElementById('wvBoard'); if(wvB)wvB.classList.add('active-view');
    loadBoard();
  }
  // v35 — quick enter transition on the view that just became visible
  // (CSS no-ops it under prefers-reduced-motion)
  var shown=view==='tracker'?tracker:view==='players'?players:view==='sheet'?sheet:view==='board'?board:null;
  if(shown){shown.classList.remove('view-enter');void shown.offsetWidth;shown.classList.add('view-enter');}
  syncTabbar(view);
}

function syncTabbar(view){
  var map={players:'tbPlayers',tracker:'tbTracker',board:'tbBoard',sheet:'tbSheet'};
  document.querySelectorAll('#tabbar .tb').forEach(function(b){b.classList.remove('on');});
  var el=document.getElementById(map[view]||'');
  if(el)el.classList.add('on');
  // v39 (pick 1A): the compact strip's desktop nav mirrors the active view
  document.querySelectorAll('#hdrNav button').forEach(function(b){
    b.classList.toggle('on',b.dataset.view===view);
  });
}

async function fetchSheetData(){
  const url=getSavedUrl();
  const loading=document.getElementById('dataLoading');
  const tableWrap=document.querySelector('.data-table-wrap');
  const filters=document.getElementById('dataFilters');
  const empty=document.getElementById('dataEmpty');
  const error=document.getElementById('dataError');

  // #1 — instant paint from cache, then refresh silently in the background
  const cached=readLbCache();
  const haveCache=cached&&cached.data&&cached.data.length;
  if(haveCache&&!dataLoaded){
    sheetData=cached.data;sheetHeaders=cached.headers||[];
    window.__lbPrevSeason=!!cached.prevSeason;
    if(sheetHeaders.length===0)sheetHeaders=Object.keys(sheetData[0]);
    sortCol=sheetHeaders[1]||sheetHeaders[0]||'';sortDir='desc';
    buildUI();applyFilters();
    filters.style.display='block';tableWrap.style.display='block';
    loading.style.display='none';empty.style.display='none';error.style.display='none';
  }else{
    loading.style.display='block';
    tableWrap.style.display='none';
    filters.style.display='none';
    empty.style.display='none';
    error.style.display='none';
  }

  if(!url){
    loading.style.display='none';
    error.style.display='block';
    document.getElementById('dataErrorMsg').textContent='Couldn\'t reach the team database. Check your connection and tap Retry.';
    return;
  }

  try{
    const json=await gasJsonp(url,{action:'fetch_all'},45000);
    if(!json.success)throw new Error(json.error||'Failed to fetch');
    sheetData=json.data||[];
    sheetHeaders=json.headers||[];
    window.__lbPrevSeason=!!json.prevSeason;
    dataLoaded=true;
    writeLbCache(sheetData,sheetHeaders,json.prevSeason);
    if(sheetData.length===0){
      buildUI();
      document.getElementById('dataFilters').style.display='block';
      loading.style.display='none';
      empty.style.display='block';
      return;
    }
    if(sheetHeaders.length===0)sheetHeaders=Object.keys(sheetData[0]);
    sortCol=sheetHeaders[1]||sheetHeaders[0]||'';
    sortDir='desc';
    buildUI();
    applyFilters();
    applyCompactPref();
    loading.style.display='none';
    filters.style.display='block';
    tableWrap.style.display='block';
    showToast(`Loaded ${sheetData.length} records`);
  }catch(e){
    if(haveCache){loading.style.display='none';return;} // keep cached view on refresh failure
    loading.style.display='none';
    error.style.display='block';
    document.getElementById('dataErrorMsg').textContent='Error: '+e.message;
  }
}

function buildUI(){
  /* Build filter dropdowns */
  const filterRow=document.getElementById('filterRow');
  filterRow.innerHTML='';
  activeFilters={};
  /* Season selector — first field in the filter row */
  const seasonDivLB=document.createElement('div');
  seasonDivLB.className='filter-field filter-field-season';
  seasonDivLB.innerHTML='<label>Season</label><select class="season-filter-select" id="seasonSelectLB"></select>';
  filterRow.appendChild(seasonDivLB);
  if(window.populateSeasonSelect)window.populateSeasonSelect(seasonDivLB.querySelector('select'));
  sheetHeaders.forEach((h,i)=>{
    if(i!==0)return; // only filter on column A (pitcher names)
    const vals=[...new Set(sheetData.map(d=>String(d[h]||'')).filter(v=>v))].sort((a,b)=>{const la=a.trim().split(' ').pop().toLowerCase(),lb=b.trim().split(' ').pop().toLowerCase();return la<lb?-1:la>lb?1:0;});
    if(vals.length<2)return;
    const div=document.createElement('div');
    div.className='filter-field';
    div.innerHTML=`<label>${h}</label><select id="filter-${CSS.escape(h)}" onchange="applyFilters()"><option value="">All</option></select>`;
    const sel=div.querySelector('select');
    vals.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;sel.appendChild(o);});
    filterRow.appendChild(div);
  });
  // Add clear button
  const clearDiv=document.createElement('div');
  clearDiv.className='filter-field filter-actions';
  clearDiv.innerHTML='<button class="filter-clear-btn" onclick="clearFilters()">Clear All</button>';
  filterRow.appendChild(clearDiv);

  /* Build table header */
  const head=document.getElementById('dataHead');
  head.innerHTML='';
  const usageTh=document.createElement('th');
  usageTh.textContent='Usage';
  usageTh.title='Pitch type usage % across all sessions';
  sheetHeaders.forEach((h,i)=>{
    if(h==='fa_count'||h==='cb_count'||h==='ch_count')return;
    const th=document.createElement('th');
    th.className='sortable';
    // #7 — velocity columns are hidden in mobile compact mode
    if(/Avg$/.test(h)) th.classList.add('col-optional');
    th.onclick=()=>sortData(h);
    const arrowClass=h===sortCol?'sort-arrow '+sortDir:'sort-arrow';
    th.innerHTML=`${h} <span class="${arrowClass}" id="sort-${CSS.escape(h)}"></span>`;
    head.appendChild(th);
    if(i===0) head.appendChild(usageTh);
  });
}

function applyFilters(){
  // Read filter values
  activeFilters={};
  sheetHeaders.forEach(h=>{
    const sel=document.getElementById('filter-'+CSS.escape(h));
    if(sel&&sel.value)activeFilters[h]=sel.value;
  });

  filteredData=sheetData.filter(d=>{
    for(const [k,v] of Object.entries(activeFilters)){
      if(String(d[k]||'')!==v)return false;
    }
    return true;
  });

  doSort();
  renderTable();
}

function clearFilters(){
  sheetHeaders.forEach(h=>{
    const sel=document.getElementById('filter-'+CSS.escape(h));
    if(sel)sel.value='';
  });
  applyFilters();
}

function sortData(col){
  if(sortCol===col){sortDir=sortDir==='asc'?'desc':'asc';}
  else{sortCol=col;sortDir='asc';}
  document.querySelectorAll('.sort-arrow').forEach(a=>{a.className='sort-arrow';});
  const arrow=document.getElementById('sort-'+CSS.escape(col));
  if(arrow)arrow.className='sort-arrow '+sortDir;
  doSort();
  renderTable();
}

function doSort(){
  filteredData.sort((a,b)=>{
    let va=a[sortCol];
    let vb=b[sortCol];
    // Try numeric comparison
    const na=Number(va), nb=Number(vb);
    if(!isNaN(na)&&!isNaN(nb)&&va!==''&&vb!==''){
      return sortDir==='asc'?na-nb:nb-na;
    }
    va=String(va||'').toLowerCase();
    vb=String(vb||'').toLowerCase();
    if(va<vb)return sortDir==='asc'?-1:1;
    if(va>vb)return sortDir==='asc'?1:-1;
    return 0;
  });
}

/* Sample-size gate for the bullpen leaderboard: a pitch-type stat only earns
   the green/red heat once that pitch has been thrown at least this many times.
   Keep in step with MIN_SAMPLE in player-stats.js. */
const MIN_PEN_PITCHES=10;
function sampleForCol(row,colIdx){
  if(!row)return null;
  const fa=Number(row['fa_count'])||0,cb=Number(row['cb_count'])||0,ch=Number(row['ch_count'])||0;
  if(colIdx===1)return fa+cb+ch;        // Overall exec
  if(colIdx===2||colIdx===3)return fa;  // FA avg / exec
  if(colIdx===4||colIdx===5)return cb;  // CB avg / exec
  if(colIdx===6||colIdx===7)return ch;  // CH avg / exec
  return null;
}
function fmtCell(val,header,headerIndex,row){
  if(val===null||val===undefined||val==='')return'—';
  const s=String(val);

  const n=Number(val);
  if(isNaN(n))return s;

  // Column layout (0-based index within sheetHeaders):
  // 0 = Name (text) — no color
  // 1 = Overall Exec %  (strike %) — color badge with %
  // 2 = FA Avg MPH      (MPH)      — color badge as number
  // 3 = FA Exec %       (strike %) — color badge with %
  // 4 = CB Avg MPH      (MPH)      — color badge as number
  // 5 = CB Exec %       (strike %) — color badge with %
  // 6 = CH Avg MPH      (MPH)      — color badge as number
  // 7 = CH Exec %       (strike %) — color badge with %
  const colIdx=headerIndex;
  const isMph = colIdx===2||colIdx===4||colIdx===6;
  const isPct = colIdx===1||colIdx===3||colIdx===5||colIdx===7;
  if(!isMph&&!isPct)return s; // name / non-stat column — untouched

  const disp = isMph ? n.toFixed(1) : ((n>1?n:n*100).toFixed(1)+'%');
  // Below the pitch-count threshold the number still shows, just uncolored.
  const cnt=sampleForCol(row,colIdx);
  const color=(cnt!==null&&cnt<MIN_PEN_PITCHES)?null:getCellColor(n,colIdx);
  if(color) return `<span class="rate-pill" style="background:${color}">${disp}</span>`;
  return `<span class="rate-plain">${disp}</span>`; // mid-tier: formatted, aligned, no pill
}

function getCellColor(pct,colIdx){
  // Column groups:
  // F(1), H(3), J(5), L(7): green>60, yellow 50-60, red<50
  // G(2): green>=75, yellow 70-75, red<70
  // I(4), K(6): green>=65, yellow 60-65, red<60

  // Column color thresholds:
  // Strike % cols: 1=Overall Exec, 3=FA Exec, 5=CB Exec, 7=CH Exec
  // MPH cols:      2=FA Avg,       4=CB Avg,              6=CH Avg
  let thresholds;
  if(colIdx===1||colIdx===3||colIdx===5||colIdx===7){
    // Strike % columns: green>60, yellow 50-60, red<50
    thresholds={greenMin:60,yellowMin:50,yellowMax:60};
  }else if(colIdx===2){
    // FA Avg MPH: green>=75, yellow 70-75, red<70
    thresholds={greenMin:75,yellowMin:70,yellowMax:75};
  }else if(colIdx===4||colIdx===6){
    // CB/CH Avg MPH: green>=65, yellow 60-65, red<60
    thresholds={greenMin:65,yellowMin:60,yellowMax:65};
  }else{
    return null; // Name column or unknown — no color
  }

  return getGradientColor(pct,thresholds);
}

function getGradientColor(pct,t){
  // Deep green to light green: above greenMin
  // greenMin threshold: transition zone
  // Yellow zone: yellowMin to yellowMax
  // Below yellowMin: light red to deep red

  if(pct>=t.greenMin){
    // Green zone: sliding from light green at threshold to deep green at extreme
    const intensity=Math.min((pct-t.greenMin)/30,1); // 30 pts above threshold = max intensity
    const r=Math.round(200-intensity*140);  // 200 → 60
    const g=Math.round(230-intensity*30);   // 230 → 200
    const b=Math.round(200-intensity*140);  // 200 → 60
    return `rgb(${r},${g},${b})`;
  }else if(pct>=t.yellowMin){
    // Mid-tier: intentionally uncolored — only the high and low ends get a pill
    return null;
  }else{
    // Red zone: sliding from light red at threshold to deep red at extreme
    const intensity=Math.min((t.yellowMin-pct)/30,1); // 30 pts below threshold = max intensity
    const r=Math.round(240-intensity*30);   // 240 → 210
    const g=Math.round(180-intensity*120);  // 180 → 60
    const b=Math.round(180-intensity*120);  // 180 → 60
    return `rgb(${r},${g},${b})`;
  }
}

// ========== TREND INDICATORS ==========
function buildUsageBar(fa, cb, ch){
  fa=Number(fa)||0; cb=Number(cb)||0; ch=Number(ch)||0;
  const tot=fa+cb+ch;
  if(tot===0) return'<span style="color:var(--text-dim);font-family:\'IBM Plex Mono\',monospace;font-size:0.6rem;">—</span>';
  const fp=Math.round(fa/tot*100), cp=Math.round(cb/tot*100), hp=Math.round(ch/tot*100);
  let labels='';
  if(fa>0) labels+=`<span class="usage-lbl usage-lbl-fa">FA ${fp}%</span>`;
  if(cb>0) labels+=`<span class="usage-lbl usage-lbl-cb">CB ${cp}%</span>`;
  if(ch>0) labels+=`<span class="usage-lbl usage-lbl-ch">CH ${hp}%</span>`;
  return`<div class="usage-cell"><div class="usage-stack">${fa>0?`<div class="usage-bar-fa" style="width:${fp}%"></div>`:''}${cb>0?`<div class="usage-bar-cb" style="width:${cp}%"></div>`:''}${ch>0?`<div class="usage-bar-ch" style="width:${hp}%"></div>`:''}</div><div class="usage-labels">${labels}</div></div>`;
}

/* v39 (pick 3A) — recency + season trend, no new columns.
   Days since the pitcher's newest recorded session; null when unparseable. */
function lbDaysAgo(ds){
  if(!ds)return null;
  let d=new Date(ds);
  if(isNaN(d)){
    const m=String(ds).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if(m)d=new Date(+(m[3].length===2?'20'+m[3]:m[3]),m[1]-1,+m[2]);
  }
  if(isNaN(d))return null;
  const n=Math.floor((Date.now()-d.getTime())/86400000);
  return n<0?0:n;
}
// ▲/▼ exec% vs last season's summary; NEW when a prior season exists but the
// pitcher wasn't on it. Nothing renders in a program's first tracked season.
function lbDeltaHtml(d){
  const cur=Number(d['Exec.']);
  if(isNaN(cur))return'';
  const c=cur>1?cur:cur*100;
  if(d['prevExec']!=null){
    const p=Number(d['prevExec']), pv=p>1?p:p*100;
    const diff=Math.round((c-pv)*10)/10;
    if(!diff)return'';
    return ' <span class="lb-delta '+(diff>0?'up':'dn')+'" title="vs last season">'+(diff>0?'▲':'▼')+' '+Math.abs(diff).toFixed(1)+'</span>';
  }
  return window.__lbPrevSeason?' <span class="lb-delta flat" title="no sessions last season">NEW</span>':'';
}
function renderTable(){
  const body=document.getElementById('dataBody');
  body.innerHTML='';
  // Skip rows where all numeric columns are 0 or empty (player hasn't thrown yet)
  const visibleNames=[];
  filteredData.forEach(d=>{
    const numericHeaders=sheetHeaders.slice(1); // exclude Name column
    const hasData=numericHeaders.some(h=>{
      const v=d[h];
      if(v===null||v===undefined||v==='')return false;
      return Number(v)>0;
    });
    if(!hasData)return; // hide players with all zeros
    const rawName=String(d[sheetHeaders[0]]||'');
    if(sheetHeaders[0])visibleNames.push(rawName);
    const tr=document.createElement('tr');
    tr.dataset.name=rawName;
    sheetHeaders.forEach((h,i)=>{
      if(h==='fa_count'||h==='cb_count'||h==='ch_count')return;
      const td=document.createElement('td');
      if(i===0){
        const ago=lbDaysAgo(d['lastDate']);
        const agoHtml=ago==null?'':'<span class="lb-ago'+(ago<=3?' hot':'')+'">'+(ago===0?'THREW TODAY':'THREW '+ago+'D AGO')+'</span>';
        td.innerHTML=`${rawName}<span class="name-expand-arrow">▶</span>${agoHtml}`;
      } else {
        if(/Avg$/.test(h)) td.classList.add('col-optional');
        td.innerHTML=fmtCell(d[h],h,i,d)+(i===1?lbDeltaHtml(d):'');
      }
      tr.appendChild(td);
      if(i===0){
        const usageTd=document.createElement('td');
        usageTd.innerHTML=buildUsageBar(d['fa_count'],d['cb_count'],d['ch_count']);
        tr.appendChild(usageTd);
      }
    });
    body.appendChild(tr);
  });
  // Refresh name filter to only show players visible in the table
  refreshNameFilter(visibleNames);
}

function refreshNameFilter(visibleNames){
  if(!sheetHeaders[0])return;
  const sel=document.getElementById('filter-'+CSS.escape(sheetHeaders[0]));
  if(!sel)return;
  const currentVal=sel.value;
  // Build unique set sorted by last name
  const unique=[...new Set(visibleNames)].sort((a,b)=>{
    const la=a.trim().split(' ').pop().toLowerCase(),lb=b.trim().split(' ').pop().toLowerCase();
    return la<lb?-1:la>lb?1:0;
  });
  sel.innerHTML='<option value="">All</option>';
  unique.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;sel.appendChild(o);});
  // Restore selection if still valid
  if(currentVal&&unique.includes(currentVal))sel.value=currentVal;
}


/* ========== VIDEO DATA ==========
   The standalone Video Library view was removed in v37 — video links live on
   the player card (pcx-vids) and in the Add-video manager. This loader only
   fills videoData for the manager's Existing-links list. */
async function fetchVideoData(){
  const url=getSavedUrl();
  if(!url)return;
  try{
    const json=await gasJsonp(url,{action:'fetch_videos'});
    if(!json.success)throw new Error(json.error||'Failed to fetch');
    videoData=json.data||[];   // grouped: [{name, videos:[{date,url}]}]
    videoLoaded=true;
  }catch(e){
    // leave videoLoaded false — the manager refetches on next open
  }
}

function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
document.getElementById('sheetsModal').addEventListener('click',e=>{if(e.target===document.getElementById('sheetsModal'))closeSheetsModal();});

/* ========== PLAYER INLINE EXPAND ========== */
// Columns H-O: [0]=Date [1]=Strike% [2]=FA MPH [3]=FA Strike% [4]=CB MPH [5]=CB Strike% [6]=CH MPH [7]=CH Strike%

// Find a video URL for a given pitcher name + date string.
// Tries both "Last, First" and "First Last" name formats.
// Date matching is flexible — normalises slashes and strips leading zeros.
function normDateKey(d){
  // Normalise any date format → M/D/YY string for comparison
  const s=String(d).trim();
  if(!s) return '';
  const dt=new Date(s);
  if(!isNaN(dt.getTime())){
    return (dt.getMonth()+1)+'/'+(dt.getDate())+'/'+String(dt.getFullYear()).slice(2);
  }
  // Fallback: strip leading zeros, convert dashes to slashes
  return s.replace(/-/g,'/').replace(/\b0(\d)/g,'$1').trim();
}

function normName(n){ return String(n).trim().toLowerCase(); }

function buildNameVariants(pitcherName){
  const names=[pitcherName];
  if(pitcherName.indexOf(',')!==-1){
    const p=pitcherName.split(',');
    names.push(p[1].trim()+' '+p[0].trim());
  } else {
    const w=pitcherName.trim().split(/\s+/);
    if(w.length>=2) names.push(w[w.length-1]+', '+w.slice(0,w.length-1).join(' '));
  }
  return names;
}

/* Per-pitch-type colors for the density heat maps below. */
const HEAT_TYPES=[['FA','Fastball','--fastball'],['BB','Breaking','--breaking-ball'],['CH','Change','--changeup']];

/* ========================================================================
   DENSITY HEAT MAPS — Baseball-Savant style pitch-location frequency.
   Red = pitches cluster here, blue = sparse. Smoothed KDE (separable
   Gaussian blur over a coarse grid) rendered to canvas, then scaled up.
   ======================================================================== */
// Colormap stops: [position, [r,g,b], alpha]. Empty areas fade transparent.
const DENSITY_STOPS=[
  [0.00,[51,77,191],0.00],
  [0.18,[51,140,242],0.55],
  [0.42,[77,204,204],0.90],
  [0.60,[242,230,77],0.92],
  [0.80,[247,140,51],0.94],
  [1.00,[217,31,36],0.96]
];
function densityRGBA(t){
  if(t<=0) return [0,0,0,0];
  if(t>=1){const L=DENSITY_STOPS[DENSITY_STOPS.length-1];return [L[1][0],L[1][1],L[1][2],L[2]];}
  for(let i=1;i<DENSITY_STOPS.length;i++){
    if(t<=DENSITY_STOPS[i][0]){
      const a=DENSITY_STOPS[i-1],b=DENSITY_STOPS[i];
      const f=(t-a[0])/((b[0]-a[0])||1);
      return [
        Math.round(a[1][0]+(b[1][0]-a[1][0])*f),
        Math.round(a[1][1]+(b[1][1]-a[1][1])*f),
        Math.round(a[1][2]+(b[1][2]-a[1][2])*f),
        a[2]+(b[2]-a[2])*f
      ];
    }
  }
  const L=DENSITY_STOPS[DENSITY_STOPS.length-1];return [L[1][0],L[1][1],L[1][2],L[2]];
}
// points: [{col,row}] in 0..ZONE_SIZE-1. Returns normalized Float32Array(GW*GH).
function buildDensityGrid(points,GW,GH,sigma){
  const g=new Float32Array(GW*GH);
  points.forEach(p=>{
    const gx=Math.min(GW-1,Math.max(0,Math.round((p.col+0.5)/ZONE_SIZE*GW-0.5)));
    const gy=Math.min(GH-1,Math.max(0,Math.round((p.row+0.5)/ZONE_SIZE*GH-0.5)));
    g[gy*GW+gx]+=1;
  });
  const rad=Math.max(1,Math.ceil(sigma*3));
  const k=new Float32Array(rad*2+1); let ksum=0;
  for(let i=-rad;i<=rad;i++){const v=Math.exp(-(i*i)/(2*sigma*sigma));k[i+rad]=v;ksum+=v;}
  for(let i=0;i<k.length;i++)k[i]/=ksum;
  const tmp=new Float32Array(GW*GH);
  for(let y=0;y<GH;y++)for(let x=0;x<GW;x++){
    let s=0;for(let i=-rad;i<=rad;i++){const xx=Math.min(GW-1,Math.max(0,x+i));s+=g[y*GW+xx]*k[i+rad];}
    tmp[y*GW+x]=s;
  }
  for(let y=0;y<GH;y++)for(let x=0;x<GW;x++){
    let s=0;for(let i=-rad;i<=rad;i++){const yy=Math.min(GH-1,Math.max(0,y+i));s+=tmp[yy*GW+x]*k[i+rad];}
    g[y*GW+x]=s;
  }
  let mx=0;for(let i=0;i<g.length;i++)if(g[i]>mx)mx=g[i];
  if(mx>0)for(let i=0;i<g.length;i++)g[i]/=mx;
  return g;
}
// Draw one pitch-type density heat map onto a canvas (with strike zone + plate).
function drawDensityHeat(canvas,points){
  if(!canvas) return;
  const wrap=canvas.parentElement;
  const cssW=Math.max(120,(canvas.clientWidth||(wrap&&wrap.clientWidth)||200));
  const cssH=Math.round(cssW*(MAP_H/MAP_W)); // keep the dot-map's aspect ratio
  const dpr=window.devicePixelRatio||1;
  canvas.style.height=cssH+'px';
  canvas.width=Math.round(cssW*dpr);
  canvas.height=Math.round(cssH*dpr);
  const ctx=canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cssW,cssH);

  // Strike zone occupies the inner 12/20 of each axis (cols/rows 4..15).
  const szX=cssW*(SZ_R0/ZONE_SIZE), szY=cssH*(SZ_R0/ZONE_SIZE);
  const szW=cssW*((SZ_C1-SZ_C0+1)/ZONE_SIZE), szH=cssH*((SZ_R1-SZ_R0+1)/ZONE_SIZE);

  if(points && points.length){
    const GW=64,GH=70,sigma=GW*0.075;
    const grid=buildDensityGrid(points,GW,GH,sigma);
    const off=document.createElement('canvas'); off.width=GW; off.height=GH;
    const octx=off.getContext('2d');
    const img=octx.createImageData(GW,GH);
    for(let i=0;i<grid.length;i++){
      const c=densityRGBA(grid[i]);
      img.data[i*4]=c[0];img.data[i*4+1]=c[1];img.data[i*4+2]=c[2];img.data[i*4+3]=Math.round(c[3]*255);
    }
    octx.putImageData(img,0,0);
    ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
    ctx.drawImage(off,0,0,GW,GH,0,0,cssW,cssH);
  }

  // Strike-zone box (dashed) + thirds
  ctx.save();
  ctx.strokeStyle='rgba(159,192,232,0.85)';
  ctx.lineWidth=1.4; ctx.setLineDash([5,4]);
  ctx.strokeRect(szX,szY,szW,szH);
  ctx.setLineDash([]);
  ctx.strokeStyle='rgba(159,192,232,0.26)'; ctx.lineWidth=0.7;
  for(let i=1;i<3;i++){
    ctx.beginPath();ctx.moveTo(szX+szW*i/3,szY);ctx.lineTo(szX+szW*i/3,szY+szH);ctx.stroke();
    ctx.beginPath();ctx.moveTo(szX,szY+szH*i/3);ctx.lineTo(szX+szW,szY+szH*i/3);ctx.stroke();
  }
  // Home plate
  const px=cssW/2, py=cssH-8, pw=Math.max(9,cssW*0.07);
  ctx.beginPath();
  ctx.moveTo(px-pw,py-pw*0.62);ctx.lineTo(px+pw,py-pw*0.62);ctx.lineTo(px+pw,py);
  ctx.lineTo(px,py+pw*0.62);ctx.lineTo(px-pw,py);ctx.closePath();
  ctx.fillStyle='rgba(255,255,255,0.07)';ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,0.26)';ctx.lineWidth=1;ctx.stroke();
  ctx.restore();
}
function densityLegendHtml(){
  return `<div class="heat-density-legend"><span>Fewer</span><i class="heat-density-bar"></i><span>More</span></div>`;
}
// flat 0..399 index → {col,row}
function flatToColRow(fi){return {col:fi%ZONE_SIZE,row:Math.floor(fi/ZONE_SIZE)};}

/* Bullpen command data for the scouting report. Returns per-pitch-type location
   points in PITCHER'S VIEW (as entered during bullpen tracking — no flip) plus
   execution % and velo from the season summary. null when no tagged locations. */
window.pcxBullpenReport=function(){
  const d=playerCardData;
  const zones=(d&&d.zones)?d.zones:[];
  if(!zones.length) return null;
  const yrs={}; zones.forEach(z=>{if(z.season)yrs[z.season]=1;});
  const ys=Object.keys(yrs).sort((a,b)=>parseFloat(b)-parseFloat(a));
  if(!ys.length) return null;
  const season=ys[0];
  const zs=zones.filter(z=>z.season===season);
  const srec=((d.seasons||[]).filter(s=>s.season===season)[0])||{};
  const DEF=[['FA','Fastball',[217,83,74]],['CH','Changeup',[230,149,42]],['BB','Breaking',[47,111,208]]];
  const map={FA:{exec:srec.faExec,velo:srec.faAvg,count:srec.faCount},
             CH:{exec:srec.chExec,velo:srec.chAvg,count:srec.chCount},
             BB:{exec:srec.cbExec,velo:srec.cbAvg,count:srec.cbCount}};
  const types=DEF.map(t=>{
    const key=t[0],pts=[];
    zs.forEach(z=>{
      const zt=(z.type==='CB'?'BB':z.type);
      if(zt!==key) return;
      const fi=ZONE_LABEL_TO_IDX[z.zone];
      if(fi===undefined) return;
      const cr=flatToColRow(fi);
      pts.push({col:cr.col,row:cr.row}); // entered in pitcher's view — no flip
    });
    const m=map[key];
    const n=(m.count!=null&&m.count>0)?m.count:pts.length;
    return {key:key,label:t[1],rgb:t[2],points:pts,n:n,
            execPct:(m.exec!=null&&m.exec>0)?m.exec:null,velo:m.velo||null};
  });
  let ew=0,en=0; types.forEach(t=>{if(t.execPct!=null&&t.n){ew+=t.execPct*t.n;en+=t.n;}});
  const total=types.reduce((a,t)=>a+(t.n||0),0);
  return {season:season,totalPitches:total,types:types,execAll:en?Math.round(ew/en):null};
};

// Keep last player-card density data so canvases can be re-rendered crisply on resize.
let _pcDensityCache=null;
let _pcDensTimer=null;
function redrawPcDensity(){
  if(!_pcDensityCache) return;
  HEAT_TYPES.forEach(([t])=>{const c=document.getElementById('pcDens-'+t);if(c)drawDensityHeat(c,_pcDensityCache[t]);});
}
window.addEventListener('resize',()=>{clearTimeout(_pcDensTimer);_pcDensTimer=setTimeout(redrawPcDensity,150);});

// Delegated click on leaderboard table — works for static + live-fetched rows
document.getElementById('dataBody').addEventListener('click', function(e){
  const td=e.target.closest('td');
  if(!td) return;
  const row=td.closest('tr');
  if(!row||row.classList.contains('expand-row')) return;
  if(td!==row.cells[0]) return;
  // Click a pitcher name → open the full player detail card
  const name=(row.dataset.name||td.textContent).replace('▶','').trim();
  if(name) openPlayerCard(name,'pit');
});


/* ========================================================================
   PLAYER DETAIL CARD — cross-season trends, command heat map, location
   Opened by clicking a pitcher name on the leaderboard.
   ======================================================================== */
let playerCardData=null;       // last fetched {name, seasons[], zones[]}
let playerCardCurrentName='';  // raw name for Manage Sessions
let playerLocYear='';          // '' = all years, else a specific season

function closePlayerCard(){ switchView(window.__playerCardReturn||'players'); }

async function openPlayerCard(name, preferTab){
  playerCardCurrentName=name;
  window.__playerCardReturn=(currentView==='sheet'||currentView==='players')?currentView:'players';

  // Hide every other view, show the player card
  document.getElementById('waffleMenu').classList.remove('open');
  document.getElementById('viewTracker').classList.add('hidden');
  document.getElementById('viewSheet').classList.remove('active');
  var playersV=document.getElementById('viewPlayers'); if(playersV)playersV.classList.remove('active');
  var boardV=document.getElementById('viewBoard'); if(boardV)boardV.classList.remove('active');
  const player=document.getElementById('viewPlayer');
  player.classList.add('active');
  document.getElementById('waffleBtn').classList.add('active');
  currentView='player';
  window.scrollTo(0,0);

  var backBtn=document.querySelector('.player-back-btn');
  if(backBtn)backBtn.textContent=(window.__playerCardReturn==='sheet')?'← Leaderboard':'← Players';

  document.getElementById('playerCardName').textContent=name;
  document.getElementById('playerCardCareer').textContent='';
  document.getElementById('playerCardBody').innerHTML='<div class="data-loading" style="display:block;"><div class="skel" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div><p>Loading player…</p></div>';

  try{
    const results=await Promise.all([
      gasJsonp(getSavedUrl(),{action:'fetch_player_history',pitcher:name}),
      gasCall(null,{action:'fetch_player_stats',pitcher:name}),
      gasJsonp(getSavedUrl(),{action:'fetch_skill_sessions',player:name,limit:0})
    ]);
    const hist=results[0], stats=results[1], skills=results[2];
    if(!hist.success) throw new Error(hist.error||'Failed to load');
    playerCardData=hist;
    window.playerStatsData=(stats&&stats.success)?stats:{statlines:[],summary:null};
    window.playerCardSkills=(skills&&skills.success)?skills.data:[];
    if(typeof window.renderUnifiedPlayerCard==='function') window.renderUnifiedPlayerCard(preferTab);
    else renderPlayerCard();
  }catch(e){
    document.getElementById('playerCardBody').innerHTML='<div class="data-error" style="display:block;"><p>Error: '+e.message+'</p><button onclick="openPlayerCard(playerCardCurrentName)">Retry</button></div>';
  }
}

function renderPlayerCard(){
  const d=playerCardData;
  const seasons=d.seasons||[];
  const totalPitches=seasons.reduce((s,x)=>s+(x.totalPitches||0),0);
  const totalSessions=seasons.reduce((s,x)=>s+(x.sessionCount||0),0);
  const careerExecNum=seasons.reduce((s,x)=>s+((x.exec||0)*(x.totalPitches||0)),0);
  const careerExec=totalPitches?Math.round(careerExecNum/totalPitches):0;
  document.getElementById('playerCardName').textContent=playerCardCurrentName;
  document.getElementById('playerCardCareer').innerHTML=
    (seasons.length?seasons.length+(seasons.length===1?' season':' seasons'):'No data')+
    (totalPitches?' · '+totalPitches+' pitches · '+totalSessions+' sessions · '+careerExec+'% career exec':'');

  if(!seasons.length){
    document.getElementById('playerCardBody').innerHTML='<div class="empty-state" style="display:block;padding:40px 16px;text-align:center;color:var(--text-dim);">No session data recorded for this pitcher yet.</div>';
    return;
  }

  playerLocYear=seasons[seasons.length-1].season;  // default to most recent year

  document.getElementById('playerCardBody').innerHTML=
    sectionSeasonTable(seasons)+sectionTrends(seasons)+sectionCommand(d)+sectionManage();

  drawTrendCharts(seasons);
  renderPlayerLocation();
}

function sectionSeasonTable(seasons){
  const rows=seasons.slice().reverse().map(s=>{
    const vfa=s.faAvg?s.faAvg:'—', vbb=s.cbAvg?s.cbAvg:'—', vch=s.chAvg?s.chAvg:'—';
    return `<tr>
      <td>${s.season}</td><td>${s.sessionCount||0}</td><td>${s.totalPitches||0}</td><td>${s.exec||0}%</td>
      <td>${vfa}${s.faExec?' · '+s.faExec+'%':''}</td>
      <td>${vbb}${s.cbExec?' · '+s.cbExec+'%':''}</td>
      <td>${vch}${s.chExec?' · '+s.chExec+'%':''}</td>
    </tr>`;
  }).join('');
  return `<div class="pc-section"><div class="pc-section-title"><svg class="icon"><use href="#i-cal"/></svg> By Season</div>
    <div class="pc-season-table-wrap"><table class="pc-season-table">
      <thead><tr><th>Season</th><th>Sess</th><th>Pitches</th><th>Exec</th><th>FA mph·ex</th><th>BB mph·ex</th><th>CH mph·ex</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
}

function sectionTrends(seasons){
  const single=seasons.length<2;
  const note=single?'<div class="pc-single-note">One season so far — trend lines build as more seasons are added.</div>':'';
  const legend=`<div class="pc-chart-legend"><span><i style="background:var(--fastball);"></i>FA</span><span><i style="background:var(--breaking-ball);"></i>BB</span><span><i style="background:var(--changeup);"></i>CH</span></div>`;
  return `<div class="pc-section"><div class="pc-section-title"><svg class="icon"><use href="#i-chart"/></svg> Year-to-Year Trends</div>
    <div class="pc-charts">
      <div class="pc-chart-card"><div class="pc-chart-head"><span>Execution %</span>${legend}</div>
        <div class="pc-chart"><svg id="pcExecChart" viewBox="0 0 320 200" xmlns="http://www.w3.org/2000/svg"></svg></div>${note}</div>
      <div class="pc-chart-card"><div class="pc-chart-head"><span>Avg Velocity (mph)</span>${legend}</div>
        <div class="pc-chart"><svg id="pcVeloChart" viewBox="0 0 320 200" xmlns="http://www.w3.org/2000/svg"></svg></div>${note}</div>
      <div class="pc-chart-card"><div class="pc-chart-head"><span>Pitch Usage %</span>${legend}</div>
        <div class="pc-chart"><svg id="pcUsageChart" viewBox="0 0 320 200" xmlns="http://www.w3.org/2000/svg"></svg></div>${note}</div>
    </div></div>`;
}

function sectionCommand(d){
  const seasons=d.seasons||[];
  const yearBtns=['<button class="pc-year-btn" data-y="" onclick="setPlayerLocYear(\'\')">All</button>']
    .concat(seasons.map(s=>`<button class="pc-year-btn" data-y="${s.season}" onclick="setPlayerLocYear('${s.season}')">${s.season}</button>`)).join('');
  return `<div class="pc-section"><div class="pc-section-title"><svg class="icon"><use href="#i-target"/></svg> Command by Zone</div>
    <div class="pc-year-row" id="pcYearRow">${yearBtns}</div>
    <div class="heat-grids" id="pcHeat"></div></div>`;
}

function sectionManage(){
  return `<div class="pc-section"><div class="pc-section-title"><svg class="icon"><use href="#i-gear"/></svg> Session Data</div>
    <button class="smgr-open-btn" onclick="openSessionMgr(playerCardCurrentName)"><svg class="icon"><use href="#i-gear"/></svg> Manage Sessions (current season)</button></div>`;
}

function setPlayerLocYear(y){
  playerLocYear=y;
  renderPlayerLocation();
}

function renderPlayerLocation(){
  const d=playerCardData; if(!d) return;
  const zones=(d.zones||[]).filter(z=>!playerLocYear||z.season===playerLocYear);
  document.querySelectorAll('#pcYearRow .pc-year-btn').forEach(b=>b.classList.toggle('active',b.dataset.y===playerLocYear));

  const byType={}; HEAT_TYPES.forEach(([t])=>{byType[t]=[];});
  const dots=[];
  zones.forEach(z=>{
    const t=(z.type==='CB'?'BB':z.type);
    const fi=ZONE_LABEL_TO_IDX[z.zone];
    if(fi===undefined) return;
    dots.push({flatIdx:fi,type:t,result:z.exec});
    if(byType[t]) byType[t].push(flatToColRow(fi));
  });
  const totalTagged=dots.length;

  const host=document.getElementById('pcHeat');
  if(host){
    // Dot map ("all pitches") rendered as the first tile, equal in size to the
    // three pitch-type heat maps so nothing dwarfs anything.
    const dotTile=`<div class="heat-density-card">
        <div class="heat-density-head"><span style="color:#cfe0f2;font-weight:700;">Locations</span>
          <span class="heat-density-meta">${totalTagged?totalTagged+'p':'—'}</span></div>
        <div class="heat-density-canvas-wrap"><svg id="pcLocMap" class="heat-density-canvas" viewBox="0 0 220 240" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"></svg></div>
      </div>`;
    const heatTiles=HEAT_TYPES.map(([t,label,cssVar])=>{
      const n=byType[t].length;
      const pct=totalTagged?Math.round(n/totalTagged*100):0;
      return `<div class="heat-density-card">
        <div class="heat-density-head"><span style="color:var(${cssVar});font-weight:700;">${label}</span>
          <span class="heat-density-meta">${n?n+'p · '+pct+'%':'—'}</span></div>
        <div class="heat-density-canvas-wrap"><canvas class="heat-density-canvas" id="pcDens-${t}"></canvas>${n?'':'<span class="heat-density-empty">no data</span>'}</div>
      </div>`;
    }).join('');
    host.innerHTML=dotTile+heatTiles+densityLegendHtml();
    _pcDensityCache=byType;
    // Dot map uses viewBox coords (no layout needed); density canvases size from
    // their rendered width, so draw those on the next frame.
    const svg=document.getElementById('pcLocMap');
    if(svg) drawSvgMap(svg,dots,dots.length===0?'No tagged pitches':'');
    requestAnimationFrame(()=>{HEAT_TYPES.forEach(([t])=>{drawDensityHeat(document.getElementById('pcDens-'+t),byType[t]);});});
  }
}

function drawTrendCharts(seasons){
  const years=seasons.map(s=>s.season);
  // Show an exec point whenever that pitch type has either recorded pitches
  // (2026 full data) OR a non-zero execution/velocity (2025 summary-only import).
  drawLineChart('pcExecChart', years, [
    {color:'var(--fastball)', label:'FA', vals:seasons.map(s=>(s.faCount||s.faExec||s.faAvg)?s.faExec:null)},
    {color:'var(--breaking-ball)', label:'BB', vals:seasons.map(s=>(s.cbCount||s.cbExec||s.cbAvg)?s.cbExec:null)},
    {color:'var(--changeup)', label:'CH', vals:seasons.map(s=>(s.chCount||s.chExec||s.chAvg)?s.chExec:null)}
  ], {yMin:0, yMax:100, yTicks:[0,25,50,75,100], unit:'%', tipUnit:'%', tipDecimals:0});

  const allV=[];
  seasons.forEach(s=>{[s.faAvg,s.cbAvg,s.chAvg].forEach(v=>{if(v>0)allV.push(v);});});
  let lo=allV.length?Math.floor(Math.min(...allV)/5)*5-2:50;
  let hi=allV.length?Math.ceil(Math.max(...allV)/5)*5+2:80;
  if(lo<0)lo=0;
  const mid=Math.round((lo+hi)/2);
  drawLineChart('pcVeloChart', years, [
    {color:'var(--fastball)', label:'FA', vals:seasons.map(s=>s.faAvg||null)},
    {color:'var(--breaking-ball)', label:'BB', vals:seasons.map(s=>s.cbAvg||null)},
    {color:'var(--changeup)', label:'CH', vals:seasons.map(s=>s.chAvg||null)}
  ], {yMin:lo, yMax:hi, yTicks:[lo,mid,hi], unit:'', tipUnit:'mph', tipDecimals:1});

  // Pitch usage % — each pitch type's share of total pitches thrown per season.
  const usage=seasons.map(s=>{
    const tot=(s.faCount||0)+(s.cbCount||0)+(s.chCount||0);
    return tot>0 ? {fa:s.faCount/tot*100, bb:s.cbCount/tot*100, ch:s.chCount/tot*100} : null;
  });
  drawLineChart('pcUsageChart', years, [
    {color:'var(--fastball)', label:'FA', vals:usage.map(u=>u?u.fa:null)},
    {color:'var(--breaking-ball)', label:'BB', vals:usage.map(u=>u?u.bb:null)},
    {color:'var(--changeup)', label:'CH', vals:usage.map(u=>u?u.ch:null)}
  ], {yMin:0, yMax:100, yTicks:[0,25,50,75,100], unit:'%', tipUnit:'%', tipDecimals:0});
}

function drawLineChart(svgId, xLabels, series, opts){
  const svg=document.getElementById(svgId);
  if(!svg) return;
  const W=320,H=200, padL=34,padR=12,padT=12,padB=28;
  const plotW=W-padL-padR, plotH=H-padT-padB;
  const n=xLabels.length;
  const xAt=i=> n<=1 ? padL+plotW/2 : padL+(plotW*i/(n-1));
  const yAt=v=> padT+plotH*(1-(v-opts.yMin)/(opts.yMax-opts.yMin));
  let s='';
  opts.yTicks.forEach(t=>{
    const y=yAt(t);
    s+=`<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="rgba(122,150,184,0.15)" stroke-width="1"/>`;
    s+=`<text x="${padL-5}" y="${y+3}" font-family="IBM Plex Mono,monospace" font-size="8" fill="rgba(122,150,184,0.6)" text-anchor="end">${t}${opts.unit}</text>`;
  });
  xLabels.forEach((lbl,i)=>{
    s+=`<text x="${xAt(i)}" y="${H-10}" font-family="IBM Plex Mono,monospace" font-size="8" fill="rgba(180,200,220,0.7)" text-anchor="middle">${lbl}</text>`;
  });
  const hits=[];
  // Nudge each pitch type slightly left/right so points sharing an x (e.g. a
  // single-season card where all three stack) stay individually hover/tappable.
  const nSeries=series.length;
  const spread=(n<=1)?12:5;
  const sx=si=> nSeries>1 ? (si-(nSeries-1)/2)*(spread*2/(nSeries-1)) : 0;
  series.forEach((ser,si)=>{
    const ox=sx(si);
    let prev=null;
    ser.vals.forEach((v,i)=>{
      if(v===null||v===undefined){prev=null;return;}
      const x=xAt(i)+ox,y=yAt(v);
      if(prev) s+=`<line x1="${prev.x}" y1="${prev.y}" x2="${x}" y2="${y}" stroke="${ser.color}" stroke-width="2" stroke-linecap="round"/>`;
      prev={x,y};
    });
    ser.vals.forEach((v,i)=>{
      if(v===null||v===undefined)return;
      const x=xAt(i)+ox,y=yAt(v);
      s+=`<circle cx="${x}" cy="${y}" r="3.5" fill="${ser.color}"/><circle cx="${x}" cy="${y}" r="1.4" fill="rgba(255,255,255,0.85)"/>`;
      hits.push({x,y,v,label:ser.label||'',color:ser.color,year:xLabels[i]});
    });
  });
  // Tooltip layer (drawn above points, populated on hover/click)
  s+=`<g class="lc-tip" style="display:none;pointer-events:none;"></g>`;
  // Transparent enlarged hit targets on top for easy hover/tap
  hits.forEach(p=>{
    s+=`<circle class="lc-hit" cx="${p.x}" cy="${p.y}" r="9" fill="transparent" style="cursor:pointer;"
      data-x="${p.x}" data-y="${p.y}" data-v="${p.v}" data-label="${p.label}" data-color="${p.color}" data-year="${p.year}"></circle>`;
  });
  svg.innerHTML=s;
  wireChartTooltips(svg, {
    unit: (opts.tipUnit!==undefined?opts.tipUnit:opts.unit)||'',
    decimals: opts.tipDecimals||0, W, H
  });
}

// Hover/click tooltips for line-chart data points
function wireChartTooltips(svg, cfg){
  const tip=svg.querySelector('.lc-tip');
  const hits=svg.querySelectorAll('.lc-hit');
  if(!tip||!hits.length) return;
  function fmtVal(v){
    const num=parseFloat(v); if(isNaN(num)) return '—';
    const r = cfg.decimals>0 ? num.toFixed(cfg.decimals) : String(Math.round(num));
    if(cfg.unit==='%') return r+'%';
    return cfg.unit ? r+' '+cfg.unit : r;
  }
  function show(hit){
    const x=parseFloat(hit.getAttribute('data-x'));
    const y=parseFloat(hit.getAttribute('data-y'));
    const valTxt=fmtVal(hit.getAttribute('data-v'));
    const color=hit.getAttribute('data-color');
    const label=hit.getAttribute('data-label');
    const year=hit.getAttribute('data-year');
    const line1=label?`${label} · ${year}`:year;
    const longest=Math.max(line1.length, valTxt.length);
    const boxW=Math.max(56, longest*5.6+24);
    const boxH=30;
    let bx=x-boxW/2, by=y-boxH-11;
    bx=Math.max(2, Math.min(bx, cfg.W-boxW-2));
    if(by<2) by=y+13;
    tip.innerHTML=
      `<circle cx="${x}" cy="${y}" r="5.5" fill="none" stroke="${color}" stroke-width="1.5"/>`+
      `<rect x="${bx}" y="${by}" width="${boxW}" height="${boxH}" rx="5" fill="rgba(9,28,49,0.97)" stroke="${color}" stroke-width="1"/>`+
      `<circle cx="${bx+11}" cy="${by+11}" r="3.2" fill="${color}"/>`+
      `<text x="${bx+19}" y="${by+13.5}" font-family="IBM Plex Mono,monospace" font-size="8" fill="#cfe0f2">${line1}</text>`+
      `<text x="${bx+11}" y="${by+24}" font-family="IBM Plex Mono,monospace" font-size="9.5" font-weight="700" fill="#ffffff">${valTxt}</text>`;
    tip.style.display='';
  }
  function hide(){ tip.style.display='none'; tip.innerHTML=''; }
  hits.forEach(h=>{
    h.addEventListener('pointerenter',()=>show(h));
    h.addEventListener('pointermove',()=>show(h));
    h.addEventListener('pointerleave',hide);
    h.addEventListener('click',e=>{e.stopPropagation();show(h);});
  });
  svg.addEventListener('click',e=>{ if(!e.target.classList||!e.target.classList.contains('lc-hit')) hide(); });
}

// Set header height CSS variables for layout + sticky positioning.
// --header-visual = the header's current on-screen height (sticky offsets).
// --header-height = the full-size height (.app top padding) — frozen while
// the portrait scroll-shrink is active so the page doesn't jump underneath.
const hdrLandscapeMQ=window.matchMedia('(max-height:500px) and (pointer:coarse)');
function updateHeaderHeight(){
  const h=document.querySelector('.brand-header');
  if(!h) return;
  const el=document.documentElement;
  // v39: the offline banner docks under the header — sticky offsets and the
  // page's top padding both need to clear it while it's showing.
  const banner=document.getElementById('offlineBanner');
  const bh=(banner&&document.body.classList.contains('lb-offline'))?banner.offsetHeight:0;
  el.style.setProperty('--hdr-raw',h.offsetHeight+'px'); // banner's own top
  const px=(h.offsetHeight+bh)+'px';
  el.style.setProperty('--header-visual',px);
  const scrollShrunk=el.classList.contains('hdr-compact')&&!hdrLandscapeMQ.matches;
  if(!scrollShrunk) el.style.setProperty('--header-height',px);
}
/* v39 (pick 2A) — offline indicator: the SW keeps serving cached data on
   dugout wifi; this makes that state visible instead of silent. */
function setOffline(off){
  document.body.classList.toggle('lb-offline',!!off);
  updateHeaderHeight();
}
window.addEventListener('offline',()=>setOffline(true));
window.addEventListener('online',()=>setOffline(false));
document.addEventListener('DOMContentLoaded',()=>setOffline(!navigator.onLine));
// v35 — compact strip header (html.hdr-compact drives the CSS): always in
// phone landscape; otherwise once scrolled past the fold, with hysteresis
// (shrink past 80px, expand back above 24px) so it never flutters.
// v37: scroll-shrink applies at every width — desktop included.
function updateHeaderCompact(){
  const el=document.documentElement;
  const was=el.classList.contains('hdr-compact');
  let want;
  if(hdrLandscapeMQ.matches) want=true;
  else want=was?window.scrollY>24:window.scrollY>80;
  if(want!==was){
    el.classList.toggle('hdr-compact',want);
    updateHeaderHeight();
    setTimeout(updateHeaderHeight,220); // re-measure after the padding transition
  }
}
updateHeaderCompact();
updateHeaderHeight();
window.addEventListener('resize',()=>{updateHeaderCompact();updateHeaderHeight();});
window.addEventListener('scroll',updateHeaderCompact,{passive:true});
// Re-measure once web fonts (Bebas Neue) finish loading — they change the
// header's height, so the first measurement above can be slightly off and
// leave the sticky info-bar misaligned until the next resize.
if(document.fonts&&document.fonts.ready){document.fonts.ready.then(updateHeaderHeight);}

/* ========================================================================
   ADD TO HOME SCREEN — installable PWA shortcut (mobile-focused).
   Android/Chromium: fires the native install prompt.
   iOS Safari (no programmatic prompt): shows Share → Add to Home Screen steps.
   Hidden entirely once the app is already installed (running standalone).
   ======================================================================== */
let deferredInstallPrompt=null;
function isStandalonePWA(){
  return window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone===true;
}
function isIOSDevice(){
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
}
function isMobileDevice(){
  return /android|iphone|ipad|ipod|mobile|silk|kindle/i.test(navigator.userAgent);
}
function showInstallButton(show){
  const b2=document.getElementById('settingsInstall');
  if(b2)b2.style.display=show?'block':'none';
  const b=document.getElementById('wvInstall');
  if(b) b.style.display=show?'':'none';
}
function refreshInstallButton(){
  // Already installed → never show. Otherwise show on mobile, or whenever the
  // browser has told us it's installable (deferred prompt captured).
  if(isStandalonePWA()){ showInstallButton(false); return; }
  showInstallButton(isMobileDevice()||!!deferredInstallPrompt);
}
window.addEventListener('beforeinstallprompt',e=>{
  e.preventDefault();
  deferredInstallPrompt=e;
  refreshInstallButton();
});
window.addEventListener('appinstalled',()=>{
  deferredInstallPrompt=null;
  showInstallButton(false);
  closeInstallModal();
});
function openInstallModal(html){
  const steps=document.getElementById('installSteps');
  const modal=document.getElementById('installModal');
  if(steps) steps.innerHTML=html;
  if(modal) modal.classList.add('open');
}
function closeInstallModal(){
  const modal=document.getElementById('installModal');
  if(modal) modal.classList.remove('open');
}
async function promptInstall(){
  const menu=document.getElementById('waffleMenu');
  if(menu) menu.classList.remove('open');
  if(deferredInstallPrompt){
    deferredInstallPrompt.prompt();
    try{
      const choice=await deferredInstallPrompt.userChoice;
      if(choice&&choice.outcome==='accepted') showInstallButton(false);
    }catch(_){/* user dismissed */}
    deferredInstallPrompt=null;
    return;
  }
  if(isIOSDevice()){
    openInstallModal(
      'On iPhone or iPad, install from Safari:'
      +'<br>1. Tap the <strong>Share</strong> icon (the square with an up arrow) at the bottom of the screen.'
      +'<br>2. Scroll down and tap <strong>Add to Home Screen</strong>.'
      +'<br>3. Tap <strong>Add</strong> — Lakers Bullpen will appear as an app icon and open full-screen.'
    );
    return;
  }
  openInstallModal(
    'To install this app:'
    +'<br>1. Open your browser menu (the <strong>⋮</strong> or <strong>⋯</strong> button).'
    +'<br>2. Choose <strong>Install app</strong> or <strong>Add to Home Screen</strong>.'
    +'<br>3. Confirm — it opens full-screen and loads instantly, even on weak wifi.'
  );
}
refreshInstallButton();
document.addEventListener('DOMContentLoaded',refreshInstallButton);

// Back to Top button — show when scrolled past the summary panel
function scrollToTop(){
  const tracker=document.getElementById('trackerSection');
  if(tracker)tracker.scrollIntoView({behavior:'smooth',block:'start'});
}
(function initBackToTop(){
  const btn=document.getElementById('backToTop');
  if(!btn)return;
  let ticking=false;
  window.addEventListener('scroll',function(){
    if(ticking)return;
    ticking=true;
    requestAnimationFrame(function(){
      // Show button when scrolled down enough that the summary is off-screen
      const tracker=document.getElementById('trackerSection');
      if(tracker&&sessionActive){
        const rect=tracker.getBoundingClientRect();
        btn.classList.toggle('visible',rect.top<-200);
      } else {
        btn.classList.remove('visible');
      }
      ticking=false;
    });
  });
})();

/* ========== COMPACT MODE (#7) ========== */
function toggleCompact(){
  const t=document.getElementById('dataTable');
  const btn=document.getElementById('compactToggle');
  if(!t)return;
  const on=t.classList.toggle('compact');
  if(btn)btn.classList.toggle('on',on);
  try{localStorage.setItem('lb_compact',on?'1':'0');}catch(e){}
}
function applyCompactPref(){
  let on=false; try{on=localStorage.getItem('lb_compact')==='1';}catch(e){}
  if(!on)return;
  const t=document.getElementById('dataTable');const btn=document.getElementById('compactToggle');
  if(t)t.classList.add('compact'); if(btn)btn.classList.add('on');
}

/* ========== CSV EXPORT (#10) ========== */
function csvEscape(v){
  const s=String(v==null?'':v);
  return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
}
async function exportSeasonCsv(){
  const si=window.__seasonInfo;
  const season=si?si.selected:'';
  if(!sheetData||!sheetData.length){showToast('No leaderboard data to export');return;}
  showToast('Building CSV…');
  // Header row from the leaderboard headers, plus usage counts
  const cols=(sheetHeaders&&sheetHeaders.length)?sheetHeaders.slice():Object.keys(sheetData[0]);
  const extra=['fa_count','cb_count','ch_count'];
  const lines=[];
  lines.push(cols.concat(extra.filter(c=>c in sheetData[0])).map(csvEscape).join(','));
  sheetData.forEach(row=>{
    const out=cols.map(c=>csvEscape(row[c]));
    extra.forEach(c=>{ if(c in row) out.push(csvEscape(row[c])); });
    lines.push(out.join(','));
  });
  const blob=new Blob([lines.join('\n')],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='lakers_bullpen_'+(season||'season')+'_leaderboard.csv';
  document.body.appendChild(a); a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},500);
  showToast('CSV downloaded');
}

/* ========== SEASON ROLLOVER (#12) ========== */
function rolloverStatus(msg,type){const el=document.getElementById('rolloverStatus');el.innerHTML=msg;el.className='modal-status'+(type?' '+type:'');}
async function openRolloverModal(){
  toggleWaffleMenu&&document.getElementById('waffleMenu')&&document.getElementById('waffleMenu').classList.remove('open');
  const si=window.__seasonInfo;
  const cur=si?si.current:new Date().getFullYear();
  document.getElementById('rolloverSub').textContent='Current season: '+cur;
  document.getElementById('rolloverYear').value=String(Number(cur)+1);
  document.getElementById('rolloverPin').value='';
  rolloverStatus('','');
  document.getElementById('rolloverModal').classList.add('open');
  // Prefill roster from the current season
  const ta=document.getElementById('rolloverRoster');
  ta.value='Loading current roster…';
  try{
    const json=await gasJsonp(getSavedUrl(),{action:'fetch_roster'});
    ta.value=(json.success&&json.roster&&json.roster.length)?json.roster.join('\n'):'';
  }catch(e){ ta.value=''; }
}
function closeRolloverModal(){document.getElementById('rolloverModal').classList.remove('open');}
async function doRollover(){
  if(document.getElementById('rolloverPin').value.trim()!=='2149'){rolloverStatus('Incorrect PIN code','error');return;}
  const year=document.getElementById('rolloverYear').value.trim();
  if(!/^\d{4}$/.test(year)){rolloverStatus('Enter a 4-digit year','error');return;}
  const roster=document.getElementById('rolloverRoster').value.split('\n').map(s=>s.trim()).filter(Boolean);
  rolloverStatus('<span class="spinner"></span> Starting '+year+'…','info');
  try{
    const json=await gasJsonp(getSavedUrl(),{action:'start_season',season:year,roster:JSON.stringify(roster)});
    if(!json.success)throw new Error(json.error||'Rollover failed');
    rolloverStatus('✓ '+year+' is now the active season','success');
    showToast(year+' season started');
    // Refresh selects + data for the new season
    if(window.populateSeasonSelect)document.querySelectorAll('.season-filter-select').forEach(window.populateSeasonSelect);
    dataLoaded=false;videoLoaded=false;
    setTimeout(()=>{closeRolloverModal();if(currentView==='sheet')fetchSheetData();},900);
  }catch(e){rolloverStatus('Error: '+e.message,'error');}
}

/* ========== VIDEO MANAGER ========== */
function vmgrSetStatus(msg,type){const el=document.getElementById('vmgrStatus');el.innerHTML=msg;el.className='modal-status'+(type?' '+type:'');}
function vmgrPinOk(){
  if(document.getElementById('vmgrPin').value.trim()==='2149')return true;
  vmgrSetStatus('Incorrect PIN code','error');
  document.getElementById('vmgrPin').focus();
  return false;
}
function vmgrSeasonGuard(){
  const si=window.__seasonInfo;
  if(si&&si.selected!==si.current){
    showToast('Season '+si.selected+' is archived — switch to '+si.current+' to add videos');
    return false;
  }
  return true;
}

function openVideoMgr(){
  if(!vmgrSeasonGuard())return;
  // videoData feeds the Existing-links list but nothing loads it on boot —
  // fetch on first open so saved links actually show up.
  if(!videoLoaded)fetchVideoData().then(()=>vmgrRenderExisting());
  // Pitcher list mirrors the tracker roster dropdown
  const src=document.getElementById('pitcher');
  const sel=document.getElementById('vmgrPitcher');
  sel.innerHTML='';
  Array.from(src.options).forEach(o=>{
    if(!o.value)return;
    const opt=document.createElement('option');
    opt.value=o.value;opt.textContent=o.value;
    sel.appendChild(opt);
  });
  document.getElementById('vmgrPin').value='';
  document.getElementById('vmgrUrl').value='';
  document.getElementById('vmgrDate').value='';
  vmgrSetStatus('','');
  vmgrRenderExisting();
  document.getElementById('vmgrModal').classList.add('open');
}
function closeVideoMgr(){document.getElementById('vmgrModal').classList.remove('open');}
document.getElementById('vmgrModal').addEventListener('click',e=>{if(e.target===document.getElementById('vmgrModal'))closeVideoMgr();});

// Show this pitcher's current links (from the already-loaded video data) with remove buttons
function vmgrRenderExisting(){
  const name=document.getElementById('vmgrPitcher').value;
  const box=document.getElementById('vmgrExisting');
  if(!name){box.innerHTML='';return;}
  const variants=buildNameVariants(name).map(normName);
  const entry=(videoData||[]).find(d=>variants.includes(normName(d.name)));
  const vids=entry?(entry.videos||[]):[];
  if(!vids.length){box.innerHTML='<div class="smgr-row-info dim" style="padding:6px 2px;">No links yet for this pitcher.</div>';return;}
  box.innerHTML='<label style="font-family:\'IBM Plex Mono\',monospace;font-size:0.6rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-dim);">Existing links</label>'+
    '<div class="smgr-list" style="max-height:160px;">'+vids.map((v,i)=>
      `<div class="smgr-row" style="grid-template-columns:1fr auto;">
        <div class="smgr-row-info">${normDateKey(v.date)||v.date}<br><span class="dim">${String(v.url||'').slice(0,46)}…</span></div>
        <button class="smgr-btn danger" id="vmgrDel-${i}" onclick="vmgrRemove(${i})"><svg class="icon"><use href="#i-trash"/></svg> Remove</button>
      </div>`).join('')+'</div>';
}

let vmgrConfirmIdx=-1;
async function vmgrRemove(i){
  if(!vmgrPinOk())return;
  if(vmgrConfirmIdx!==i){
    vmgrConfirmIdx=i;
    document.getElementById('vmgrDel-'+i).textContent='Tap again to confirm';
    return;
  }
  vmgrConfirmIdx=-1;
  const name=document.getElementById('vmgrPitcher').value;
  const variants=buildNameVariants(name).map(normName);
  const entry=(videoData||[]).find(d=>variants.includes(normName(d.name)));
  const v=entry&&entry.videos[i];
  if(!v)return;
  vmgrSetStatus('<span class="spinner"></span> Removing…','info');
  try{
    const json=await gasJsonp(getSavedUrl(),{action:'remove_video',pitcher:name,date:v.date,url:v.url});
    if(!json.success)throw new Error(json.error||'Remove failed');
    entry.videos.splice(i,1);
    vmgrSetStatus('✓ Link removed','success');
    vmgrRenderExisting();
    videoLoaded=false;fetchVideoData();
  }catch(e){vmgrSetStatus('Error: '+e.message,'error');}
}

async function vmgrAdd(){
  if(!vmgrPinOk())return;
  const name=document.getElementById('vmgrPitcher').value;
  const date=document.getElementById('vmgrDate').value.trim();
  const url=document.getElementById('vmgrUrl').value.trim();
  if(!name){vmgrSetStatus('Select a pitcher','error');return;}
  if(!date){vmgrSetStatus('Pick the session date','error');return;}
  if(!url.startsWith('http')){vmgrSetStatus('Paste a full link (starts with https://)','error');return;}
  vmgrSetStatus('<span class="spinner"></span> Adding…','info');
  try{
    const json=await gasJsonp(getSavedUrl(),{action:'add_video',pitcher:name,date:date,url:url});
    if(!json.success)throw new Error(json.error||'Add failed');
    vmgrSetStatus('✓ Video added for '+name,'success');
    document.getElementById('vmgrUrl').value='';
    videoLoaded=false;
    await fetchVideoData();
    vmgrRenderExisting();
  }catch(e){vmgrSetStatus('Error: '+e.message,'error');}
}

/* ========== SESSION MANAGER & DATA REFRESH ========== */
function refreshLeaderboardData(){
  dataLoaded=false;
  fetchSheetData(); // background refresh so the leaderboard is current on next visit
}

const smgrState={pitcher:'',sessions:[],editIdx:-1,confirmIdx:-1};

function smgrSeasonGuard(){
  const si=window.__seasonInfo;
  if(si&&si.selected!==si.current){
    showToast('Season '+si.selected+' is archived — switch to '+si.current+' to make changes');
    return false;
  }
  return true;
}

async function openSessionMgr(pitcherName){
  if(!smgrSeasonGuard())return;
  smgrState.pitcher=pitcherName;smgrState.editIdx=-1;smgrState.confirmIdx=-1;
  document.getElementById('smgrTitle').textContent='Manage Sessions';
  document.getElementById('smgrSubtitle').textContent=pitcherName;
  document.getElementById('smgrPin').value='';
  setSmgrStatus('','');
  document.getElementById('smgrBody').innerHTML='<div class="expand-loading">Loading sessions…</div>';
  document.getElementById('smgrModal').classList.add('open');
  try{
    const json=await gasJsonp(getSavedUrl(),{action:'fetch_sessions',pitcher:pitcherName});
    if(!json.success)throw new Error(json.error||'Failed to load');
    smgrState.sessions=json.data||[];
    renderSmgrList();
  }catch(e){
    document.getElementById('smgrBody').innerHTML='<div class="expand-error">Error: '+e.message+'</div>';
  }
}

function closeSessionMgr(){document.getElementById('smgrModal').classList.remove('open');}
document.getElementById('smgrModal').addEventListener('click',e=>{if(e.target===document.getElementById('smgrModal'))closeSessionMgr();});
function setSmgrStatus(msg,type){const el=document.getElementById('smgrStatus');el.innerHTML=msg;el.className='modal-status'+(type?' '+type:'');}
function smgrPinOk(){
  if(document.getElementById('smgrPin').value.trim()==='2149')return true;
  setSmgrStatus('Incorrect PIN code','error');
  document.getElementById('smgrPin').focus();
  return false;
}

function renderSmgrList(){
  smgrState.editIdx=-1;smgrState.confirmIdx=-1;
  document.getElementById('smgrTitle').textContent='Manage Sessions';
  document.getElementById('smgrActions').innerHTML='<button class="btn btn-cancel" onclick="closeSessionMgr()">Close</button>';
  const body=document.getElementById('smgrBody');
  if(!smgrState.sessions.length){
    body.innerHTML='<div class="expand-loading">No saved sessions for this pitcher.</div>';
    return;
  }
  body.innerHTML='<div class="smgr-list">'+smgrState.sessions.map((s,i)=>{
    const d=normDateKey(s.date)||s.date;
    const n=(s.pitches||[]).length;
    return `<div class="smgr-row">
      <div class="smgr-row-info">${d} · ${s.sessionType||'Bullpen'}<br><span class="dim">${n} pitches</span></div>
      <button class="smgr-btn" onclick="smgrEdit(${i})">✎ Edit</button>
      <button class="smgr-btn danger" id="smgrDel-${i}" onclick="smgrDelete(${i})"><svg class="icon"><use href="#i-trash"/></svg> Delete</button>
    </div>`;
  }).join('')+'</div>';
}

async function smgrDelete(i){
  if(!smgrPinOk())return;
  if(smgrState.confirmIdx!==i){
    smgrState.confirmIdx=i;
    document.getElementById('smgrDel-'+i).textContent='Tap again to confirm';
    setSmgrStatus('Deleting removes this session permanently and updates the leaderboard.','info');
    return;
  }
  const s=smgrState.sessions[i];
  setSmgrStatus('<span class="spinner"></span> Deleting…','info');
  try{
    const json=await gasJsonp(getSavedUrl(),{action:'delete_session',pitcher:smgrState.pitcher,sessionId:s.id});
    if(!json.success)throw new Error(json.error||'Delete failed');
    smgrState.sessions.splice(i,1);
    renderSmgrList();
    setSmgrStatus('✓ Session deleted','success');
    showToast('Session deleted');
    refreshLeaderboardData();
  }catch(e){setSmgrStatus('Error: '+e.message,'error');smgrState.confirmIdx=-1;}
}

const SMGR_TYPES=['FA','BB','CH'];
const SMGR_DELIV=['','Stretch','Windup'];
const SMGR_RESULTS=['','Executed','Not Executed'];
const SMGR_SESSIONS=['Preset Bullpen','Dynamic Bullpen','Game','Bullpen'];
function smgrSel(cls,options,val){
  return '<select class="'+cls+'">'+options.map(o=>'<option value="'+o+'"'+(String(o)===String(val||'')?' selected':'')+'>'+(o||'—')+'</option>').join('')+'</select>';
}

function smgrEdit(i){
  smgrState.editIdx=i;smgrState.confirmIdx=-1;
  const s=smgrState.sessions[i];
  document.getElementById('smgrTitle').textContent='Edit Session';
  setSmgrStatus('','');
  const st=SMGR_SESSIONS.includes(s.sessionType)?s.sessionType:(s.sessionType||'Bullpen');
  const stOpts=SMGR_SESSIONS.includes(st)?SMGR_SESSIONS:[st].concat(SMGR_SESSIONS);
  document.getElementById('smgrBody').innerHTML=
    '<div class="smgr-meta">'+
      '<div class="modal-field"><label>Date</label><input type="text" id="smgrDate" value="'+String(s.date||'').replace(/"/g,'&quot;')+'" placeholder="M/D/YY"></div>'+
      '<div class="modal-field"><label>Session Type</label>'+smgrSel('',stOpts,st).replace('<select','<select id="smgrType"')+'</div>'+
    '</div>'+
    '<div class="smgr-table-wrap"><table class="smgr-table"><thead><tr><th>#</th><th>Type</th><th>Delivery</th><th>Velo</th><th>Result</th><th>Zone</th><th></th></tr></thead><tbody id="smgrRows"></tbody></table></div>'+
    '<div class="smgr-foot"><button class="smgr-btn" onclick="smgrAddRow()">+ Add Pitch</button><span class="smgr-row-info dim" id="smgrCount"></span></div>';
  document.getElementById('smgrActions').innerHTML=
    '<button class="btn btn-cancel" onclick="renderSmgrList()">← Back</button>'+
    '<button class="btn btn-sheets-send" onclick="smgrSave()"><svg class="icon"><use href="#i-save"/></svg> Save Changes</button>';
  const tbody=document.getElementById('smgrRows');
  (s.pitches||[]).forEach(p=>tbody.appendChild(smgrRowEl(p)));
  smgrRenumber();
}

function smgrRowEl(p){
  p=p||{};
  const tr=document.createElement('tr');
  tr.innerHTML='<td class="smgr-num smgr-row-info dim"></td>'+
    '<td>'+smgrSel('ptype',SMGR_TYPES,normTypeSmgr(p.pitchType))+'</td>'+
    '<td>'+smgrSel('pdeliv',SMGR_DELIV,p.delivery)+'</td>'+
    '<td><input class="velo" type="number" min="0" max="120" value="'+String(p.velo||'').replace(/"/g,'')+'"></td>'+
    '<td>'+smgrSel('presult',SMGR_RESULTS,p.result)+'</td>'+
    '<td><input class="zone" type="text" maxlength="8" value="'+String(p.zone||'').replace(/"/g,'')+'" placeholder="R10C09"></td>'+
    '<td><button class="smgr-x" title="Remove pitch" onclick="this.closest(\'tr\').remove();smgrRenumber();">✕</button></td>';
  return tr;
}
function normTypeSmgr(t){const u=String(t||'FA').trim().toUpperCase();return u==='CB'?'BB':(SMGR_TYPES.includes(u)?u:'FA');}
function smgrAddRow(){document.getElementById('smgrRows').appendChild(smgrRowEl());smgrRenumber();}
function smgrRenumber(){
  const rows=document.querySelectorAll('#smgrRows tr');
  rows.forEach((r,i)=>{r.querySelector('.smgr-num').textContent=i+1;});
  const c=document.getElementById('smgrCount');if(c)c.textContent=rows.length+' pitches';
}

async function smgrSave(){
  if(!smgrPinOk())return;
  const s=smgrState.sessions[smgrState.editIdx];
  const date=document.getElementById('smgrDate').value.trim();
  if(!date){setSmgrStatus('Date is required','error');return;}
  const pitchRows=[];
  document.querySelectorAll('#smgrRows tr').forEach((r,i)=>{
    pitchRows.push({
      number:i+1,
      pitchType:r.querySelector('.ptype').value,
      delivery:r.querySelector('.pdeliv').value,
      velo:r.querySelector('.velo').value.trim(),
      zone:r.querySelector('.zone').value.trim(),
      result:r.querySelector('.presult').value
    });
  });
  if(!pitchRows.length){setSmgrStatus('A session needs at least 1 pitch — use Delete instead to remove it entirely','error');return;}
  setSmgrStatus('<span class="spinner"></span> Saving…','info');
  try{
    const json=await gasJsonp(getSavedUrl(),{
      action:'update_session',pitcher:smgrState.pitcher,sessionId:s.id,
      date:date,session:document.getElementById('smgrType').value,
      pitches:JSON.stringify(pitchRows)
    });
    if(!json.success)throw new Error(json.error||'Save failed');
    s.date=date;s.sessionType=document.getElementById('smgrType').value;s.pitches=pitchRows;
    setSmgrStatus('✓ Saved — leaderboard updated','success');
    showToast('Session updated');
    refreshLeaderboardData();
    renderSmgrList();
  }catch(e){setSmgrStatus('Error: '+e.message,'error');}
}

switchView('players');

/* ═══════════════════════════════════════════════════════════════
   v26 — AVAILABILITY BOARD · SKILL SESSIONS · NAV · SETTINGS
   ═══════════════════════════════════════════════════════════════ */

/* ── MSHSL rest rules (varsity defaults, editable in Team Settings) ──
   tiers: [maxPitchesInTier, calendarDaysRest] · Bylaw 502 */
const BOARD_DEFAULT_RULES={maxDaily:105,maxPlayoff:115,maxConsecutive:2,
  tiers:[[30,0],[50,1],[75,2],[105,3]]};
let boardRules=null, boardOutings=null, boardLoadedAt=0;

function todayISO(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function dayDiff(a,b){return Math.round((new Date(b+'T12:00')-new Date(a+'T12:00'))/86400000);}
function addDays(iso,n){const d=new Date(iso+'T12:00');d.setDate(d.getDate()+n);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function fmtMD(iso){const p=iso.split('-');return ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+p[1]]+' '+(+p[2]);}
function fmtWD(iso){return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(iso+'T12:00').getDay()];}
function restDaysFor(pitches,rules){for(const t of rules.tiers){if(pitches<=t[0])return t[1];}return rules.tiers[rules.tiers.length-1][1];}

async function fetchBoardData(force){
  if(!force && boardOutings && Date.now()-boardLoadedAt<60000)return;
  const [oRes,cRes]=await Promise.all([
    gasJsonp(getSavedUrl(),{action:'fetch_outings'}),
    gasJsonp(getSavedUrl(),{action:'fetch_board_config'})
  ]);
  boardOutings=(oRes&&oRes.success)?oRes.data:[];
  boardRules=(cRes&&cRes.success&&cRes.rules)?cRes.rules:BOARD_DEFAULT_RULES;
  boardLoadedAt=Date.now();
}

/* Compute per-pitcher availability from logged outings. */
function computeAvailability(){
  const rules=boardRules||BOARD_DEFAULT_RULES, today=todayISO();
  const by={};
  (boardOutings||[]).forEach(o=>{(by[o.pitcher]=by[o.pitcher]||[]).push(o);});
  // Roster pitchers with no outings are available too
  document.querySelectorAll('#pitcher option').forEach(op=>{if(op.value&&!by[op.value])by[op.value]=[];});
  const rows=[];
  Object.keys(by).forEach(name=>{
    const outs=by[name].slice().sort((a,b)=>a.date<b.date?1:-1);
    const seasonP=outs.reduce((s,o)=>s+(+o.pitches||0),0);
    const last=outs[0]||null;
    let status='ok',note='',eligible=today,restReq=0;
    if(last){
      restReq=restDaysFor(+last.pitches,rules);
      eligible=addDays(last.date,restReq+ (restReq>0?1:0));
      if(restReq>0&&dayDiff(today,eligible)>0){status='rest';}
      else{
        // consecutive-day rule: pitched yesterday AND the day before → blocked
        const y=addDays(today,-1),y2=addDays(today,-2);
        const pY=outs.some(o=>o.date===y),pY2=outs.some(o=>o.date===y2);
        if(pY&&pY2){status='rest';eligible=addDays(today,1);note=rules.maxConsecutive+' consecutive days reached';}
        else if(pY){status='warn';note='2nd straight day';}
      }
    }
    rows.push({name,last,seasonP,status,note,eligible,restReq});
  });
  rows.sort((a,b)=>{
    const rank={warn:0,rest:1,ok:2};
    if(rank[a.status]!==rank[b.status])return rank[a.status]-rank[b.status];
    if(a.status==='rest'&&a.eligible!==b.eligible)return a.eligible<b.eligible?-1:1;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

async function loadBoard(force){
  const loading=document.getElementById('boardLoading');
  if(loading&&!boardOutings)loading.style.display='block';
  try{await fetchBoardData(force);}catch(e){}
  if(loading)loading.style.display='none';
  renderBoard();
}

function boardStatusChip(r){
  const max=(boardRules||BOARD_DEFAULT_RULES).maxDaily;
  if(r.status==='ok')return '<span class="bchip g">✓ Available · '+max+'</span>';
  if(r.status==='warn')return '<span class="bchip a">⚠ '+r.note+'</span>';
  // v39 (pick 5B): the chip answers the planning question directly —
  // amber when the arm is back tomorrow, red with the return day otherwise.
  if(dayDiff(todayISO(),r.eligible)<=1)return '<span class="bchip a">◔ Back tomorrow</span>';
  return '<span class="bchip r">✗ Back '+fmtWD(r.eligible)+' '+fmtMD(r.eligible)+'</span>';
}

function renderBoard(){
  const rows=computeAvailability(), rules=boardRules||BOARD_DEFAULT_RULES;
  const n={ok:0,warn:0,rest:0};rows.forEach(r=>n[r.status]++);
  const chips=document.getElementById('boardChips');
  if(chips)chips.innerHTML='<span class="bchip g">'+n.ok+' available</span><span class="bchip a">'+n.warn+' limited</span><span class="bchip r">'+n.rest+' resting</span>';
  const body=document.getElementById('boardRows');
  if(body){
    const noHist=rows.filter(r=>r.status==='ok'&&!r.last);
    const shown=rows.filter(r=>!(r.status==='ok'&&!r.last));
    body.innerHTML=(shown.length||noHist.length)?(shown.map(r=>
      '<div class="board-row" onclick="openPlayerCard(\''+r.name.replace(/'/g,"\\'")+'\')">'
      +'<span class="brd-name">'+r.name+'</span>'
      +'<span class="brd-meta">'+(r.last?('Last: <b>'+r.last.pitches+'p</b> · '+fmtMD(r.last.date)+(r.restReq?('<br>'+r.restReq+' day'+(r.restReq>1?'s':'')+' rest req.'):'')):'No outings logged')+'</span>'
      +boardStatusChip(r)
      +'<span class="brd-season">'+r.seasonP+'<small>season</small></span></div>'
    ).join('')
    +(noHist.length?'<div class="board-row board-more" onclick="toggleBoardMore(event)"><span class="brd-name">＋ '+noHist.length+' more available</span><span class="brd-meta">No game outings logged — full daily max</span><span class="bchip g">✓ Available</span></div><div id="boardMore" style="display:none;">'+noHist.map(r=>'<div class="board-row" onclick="openPlayerCard(\''+r.name.replace(/'/g,"\\'")+'\')"><span class="brd-name">'+r.name+'</span><span class="brd-meta">No outings logged</span>'+boardStatusChip(r)+'</div>').join('')+'</div>':''))
    :'<div class="data-empty" style="display:block;"><p>No pitchers yet — log a game outing to start the board.</p></div>';
  }
  const tiers=document.getElementById('boardTiers');
  if(tiers){
    let lo=1;
    tiers.innerHTML=rules.tiers.map(t=>{const html='<div class="tier"><div class="n">'+lo+'–'+t[0]+'</div><div class="d">'+t[1]+' day'+(t[1]===1?'':'s')+'</div></div>';lo=t[0]+1;return html;}).join('');
  }
  const foot=document.getElementById('boardFoot');
  if(foot)foot.innerHTML='Calendar days, not 24-hr periods · daily max '+rules.maxDaily+' ('+rules.maxPlayoff+' playoffs) · max '+rules.maxConsecutive+' consecutive days · MSHSL Bylaw 502 defaults — edit in <svg class="icon"><use href="#i-gear"/></svg> Team Settings';
  const rec=document.getElementById('boardRecent');
  if(rec){
    const outs=(boardOutings||[]).slice(0,8);
    rec.innerHTML=outs.length?('<div class="brd-rec-title">Recent outings</div>'+outs.map(o=>
      '<div class="brd-rec-row"><span>'+fmtMD(o.date)+'</span><b>'+o.pitcher+'</b><span>'+o.pitches+' pitches</span>'
      +'<button class="brd-del" onclick="deleteOuting(\''+o.id+'\',event)" title="Delete">✕</button></div>').join('')):'';
  }
}

function openOutingModal(){
  const sel=document.getElementById('outingPitcher');
  sel.innerHTML=document.getElementById('pitcher').innerHTML.replace('— Select Pitcher —','— Select Pitcher —');
  document.getElementById('outingDate').value=todayISO();
  document.getElementById('outingPitches').value='';
  document.getElementById('outingPin').value='';
  setOutingStatus('','');
  document.getElementById('outingModal').classList.add('open');
}
function closeOutingModal(){document.getElementById('outingModal').classList.remove('open');}
function setOutingStatus(m,t){const el=document.getElementById('outingStatus');el.textContent=m;el.className='modal-status'+(t?' '+t:'');}
async function saveOuting(){
  const pitcher=document.getElementById('outingPitcher').value;
  const date=document.getElementById('outingDate').value;
  const pitches=document.getElementById('outingPitches').value;
  if(document.getElementById('outingPin').value.trim()!=='2149'){setOutingStatus('Incorrect PIN code','error');return;}
  if(!pitcher||!date||!(+pitches>0)){setOutingStatus('Pitcher, date and pitches are required','error');return;}
  setOutingStatus('Saving…','');
  const res=await gasJsonp(getSavedUrl(),{action:'log_outing',pitcher,date,pitches});
  if(res&&res.success){closeOutingModal();showToast('Outing logged — board updated');loadBoard(true);}
  else setOutingStatus((res&&res.error)||'Save failed','error');
}
async function deleteOuting(id,ev){
  if(ev)ev.stopPropagation();
  const pin=prompt('Enter PIN to delete this outing:');
  if(pin===null)return;
  if(pin.trim()!=='2149'){showToast('Incorrect PIN code');return;}
  const res=await gasJsonp(getSavedUrl(),{action:'delete_outing',id});
  if(res&&res.success){showToast('Outing deleted');loadBoard(true);}
  else showToast((res&&res.error)||'Delete failed');
}

/* ═══════════ SKILLS LEADERBOARD (pop · sprint · BP) ═══════════ */
let lbActivity='bullpen', lbSkillCache={};

function setLbActivity(a){
  lbActivity=a;
  document.querySelectorAll('#lbActSeg button').forEach(b=>b.classList.toggle('on',b.dataset.a===a));
  const bull=document.getElementById('lbBullpenWrap'), skills=document.getElementById('lbSkillsWrap');
  if(a==='bullpen'){bull.style.display='';skills.style.display='none';}
  else{bull.style.display='none';skills.style.display='';loadSkillsLeaderboard(a);}
}

// aggregate one player's sessions of a given kind into best/avg/rep summary
function aggSkill(kind,sessions){
  if(kind==='pop'){
    const throws=sessions.flatMap(s=>s.data.throws||[]);
    if(!throws.length)return null;
    const ts=throws.map(x=>x.t), marked=throws.filter(x=>x.ok!==null), on=throws.filter(x=>x.ok===true).length;
    return {best:Math.min(...ts),avg:ts.reduce((a,b)=>a+b,0)/ts.length,reps:ts.length,
      onTgt:marked.length?Math.round(on/marked.length*100):null,last:sessions[0].date};
  }
  if(kind==='sprint'){
    const reps=sessions.flatMap(s=>s.data.sprints||s.data.runs||[]);
    if(!reps.length)return null;
    const ts=reps.map(x=>x.t);
    return {best:Math.min(...ts),avg:ts.reduce((a,b)=>a+b,0)/ts.length,reps:ts.length,last:sessions[0].date};
  }
  // bp
  const swings=sessions.flatMap(s=>(s.data.rounds||[]).flatMap(r=>r.swings||[]));
  if(!swings.length)return null;
  const res=swings.map(x=>(x&&typeof x==='object')?x.r:x);
  const h=res.filter(x=>x==='H').length, w=res.filter(x=>x==='W').length, m=res.filter(x=>x==='M').length;
  const velos=swings.map(x=>(x&&typeof x==='object')?x.v:null).filter(v=>v!=null);
  return {hardPct:Math.round(h/swings.length*100),weakPct:Math.round(w/swings.length*100),missPct:Math.round(m/swings.length*100),
    swings:swings.length,sessions:sessions.length,topEV:velos.length?Math.max(...velos):null,avgEV:velos.length?velos.reduce((a,b)=>a+b,0)/velos.length:null,last:sessions[0].date};
}

async function loadSkillsLeaderboard(kind){
  const host=document.getElementById('lbSkillsHost'), loading=document.getElementById('lbSkillsLoading');
  const si=window.__seasonInfo, seasonKey=(si?si.selected:'cur')+'_'+kind;
  if(lbSkillCache[seasonKey]){renderSkillsLeaderboard(kind,lbSkillCache[seasonKey]);return;}
  host.innerHTML='';loading.style.display='block';
  let rows=[];
  try{
    const res=await gasJsonp(getSavedUrl(),{action:'fetch_skill_sessions',kind:kind,limit:0});
    if(res&&res.success&&res.data){
      const byPlayer={};
      res.data.forEach(s=>{(byPlayer[s.player]=byPlayer[s.player]||[]).push(s);});
      Object.keys(byPlayer).forEach(name=>{
        const sess=byPlayer[name].sort((a,b)=>a.date<b.date?1:-1);
        const agg=aggSkill(kind,sess);
        if(agg)rows.push(Object.assign({player:name},agg));
      });
    }
  }catch(e){}
  lbSkillCache[seasonKey]=rows;
  loading.style.display='none';
  renderSkillsLeaderboard(kind,rows);
}

function renderSkillsLeaderboard(kind,rows){
  const host=document.getElementById('lbSkillsHost');
  if(!rows.length){host.innerHTML='<div class="data-empty" style="display:block;"><p>No '+({pop:'pop-time',sprint:'sprint',bp:'BP'})[kind]+' sessions saved this season yet. Log one from the Tracker tab.</p></div>';return;}
  let head,body,foot;
  if(kind==='pop'||kind==='sprint'){
    rows.sort((a,b)=>a.best-b.best); // fastest first
    const unit=kind==='pop'?'Pop':'Sprint';
    head='<tr><th class="rank">#</th><th>Player</th><th>Best '+unit+'</th><th>Avg '+unit+'</th>'+(kind==='pop'?'<th>On-Tgt%</th>':'')+'<th>'+(kind==='pop'?'Throws':'Sprints')+'</th><th>Last</th></tr>';
    body=rows.map((r,i)=>'<tr onclick="openPlayerCard(\''+r.player.replace(/'/g,"\\'")+'\',\'fld\')">'
      +'<td class="rank'+(i===0?' top':'')+'">'+(i+1)+'</td>'
      +'<td class="lb-nm">'+r.player+'</td>'
      +'<td><span class="lb-best">'+r.best.toFixed(2)+'</span></td>'
      +'<td class="lb-avg">'+r.avg.toFixed(2)+'</td>'
      +(kind==='pop'?'<td class="mono dim">'+(r.onTgt!=null?r.onTgt+'%':'—')+'</td>':'')
      +'<td class="mono dim">'+r.reps+'</td><td class="mono dim">'+fmtMD(r.last)+'</td></tr>').join('');
    foot=(kind==='pop'?'Best = fastest single throw · Avg = mean of all throws · ':'90 ft home → first · best & avg of all sprints · ')+'fastest first · tap a player for their card';
  }else{
    rows.sort((a,b)=>b.hardPct-a.hardPct); // best contact first
    const anyEV=rows.some(r=>r.topEV!=null);
    head='<tr><th class="rank">#</th><th>Player</th><th>Hard%</th><th>Weak%</th><th>Miss%</th>'+(anyEV?'<th>Top EV</th><th>Avg EV</th>':'')+'<th>Swings</th><th>Last</th></tr>';
    body=rows.map((r,i)=>'<tr onclick="openPlayerCard(\''+r.player.replace(/'/g,"\\'")+'\',\'hit\')">'
      +'<td class="rank'+(i===0?' top':'')+'">'+(i+1)+'</td>'
      +'<td class="lb-nm">'+r.player+'</td>'
      +'<td><span class="lb-best">'+r.hardPct+'%</span></td>'
      +'<td class="lb-avg">'+r.weakPct+'%</td>'
      +'<td class="mono dim">'+r.missPct+'%</td>'
      +(anyEV?'<td class="mono">'+(r.topEV!=null?r.topEV.toFixed(1):'—')+'</td><td class="mono dim">'+(r.avgEV!=null?r.avgEV.toFixed(1):'—')+'</td>':'')
      +'<td class="mono dim">'+r.swings+'</td><td class="mono dim">'+fmtMD(r.last)+'</td></tr>').join('');
    foot='Hard / Weak / Miss are shares of all charted swings · ranked by hard% · exit velo shown when logged off a Pocket Radar';
  }
  host.innerHTML='<div class="data-table-wrap"><table class="data-table lb-skill-table"><thead>'+head+'</thead><tbody>'+body+'</tbody></table></div><div class="lb-skill-foot">'+foot+'</div>';
}

// keep skills cache fresh when the season changes or a refresh happens
function clearSkillLbCache(){lbSkillCache={};}

/* ── Track modes: bullpen | pop | sprint | bp ── */
let trackMode='bullpen';
function setTrackMode(mode){
  trackMode=mode;
  document.querySelectorAll('#trackModeSeg button').forEach(b=>b.classList.toggle('on',b.dataset.mode===mode));
  document.getElementById('bullpenMode').style.display=(mode==='bullpen')?'':'none';
  document.getElementById('skillMode').style.display=(mode==='bullpen')?'none':'';
  ['pop','sprint','bp'].forEach(k=>{document.getElementById(k+'Panel').style.display=(mode===k)?'':'none';});
  if(mode!=='bullpen'){ensureSkillPlayers();if(!document.getElementById('skillDate').value)document.getElementById('skillDate').value=todayISO();renderSkill();loadSkillRecent();}
}
async function ensureSkillPlayers(){
  const sel=document.getElementById('skillPlayer');
  if(sel.options.length>1)return;
  try{
    const res=await gasCall(null,{action:'fetch_players_hub'});
    if(res&&res.success&&res.data&&res.data.length){
      sel.innerHTML='<option value="">— Select Player —</option>'+res.data.map(p=>'<option value="'+escapeHtml(p.name)+'">'+escapeHtml(p.name)+'</option>').join('');
      return;
    }
  }catch(e){}
  sel.innerHTML=document.getElementById('pitcher').innerHTML.replace('— Select Pitcher —','— Select Player —');
}

/* shared stopwatch */
function makeWatch(btnId,label,onStop){
  let t0=null,raf=null;
  const btn=()=>document.getElementById(btnId);
  function tick(){if(t0===null)return;btn().textContent='■ '+((performance.now()-t0)/1000).toFixed(2);raf=requestAnimationFrame(tick);}
  return function(){
    if(t0===null){t0=performance.now();btn().classList.add('running');tick();}
    else{const t=(performance.now()-t0)/1000;t0=null;cancelAnimationFrame(raf);btn().classList.remove('running');btn().textContent=label;onStop(Math.round(t*100)/100);}
  };
}

/* pop times */
let popThrows=[],popTarget='2B';
function popSetTarget(t){popTarget=t;document.querySelectorAll('#popTargetSeg button').forEach(b=>b.classList.toggle('on',b.dataset.t===t));}
const popWatchTap=makeWatch('popWatch','▶ START THROW',t=>{popThrows.push({t,target:popTarget,ok:null});renderSkill();});
function popAddManual(){const v=prompt('Pop time (seconds, e.g. 2.05):');const t=parseFloat(v);if(!(t>0))return;popThrows.push({t:Math.round(t*100)/100,target:popTarget,ok:null});renderSkill();}
function popMark(i,ok){popThrows[i].ok=ok;renderSkill();}
function popDel(i){popThrows.splice(i,1);renderSkill();}

/* sprints — single distance (90 ft, home→first), timed */
const SPRINT_DIST='90 ft';
let sprintReps=[];
const sprintWatchTap=makeWatch('sprintWatch','▶ START SPRINT',t=>{sprintReps.push({d:SPRINT_DIST,t});renderSkill();});
function sprintAddManual(){const v=prompt('Sprint time (seconds, e.g. 4.35):');const t=parseFloat(v);if(!(t>0))return;sprintReps.push({d:SPRINT_DIST,t:Math.round(t*100)/100});renderSkill();}
function sprintDel(i){sprintReps.splice(i,1);renderSkill();}

/* bp rounds — swings are objects {r:'H'|'W'|'M', v:exitVelo|null}
   exit velo is optional, entered off a Pocket Radar when the toggle is on. */
let bpRounds=[], bpVeloOn=false;
function bpSwingResult(s){return (s&&typeof s==='object')?s.r:s;}   // back-compat: old data was bare strings
function bpSwingVelo(s){return (s&&typeof s==='object')?s.v:null;}
function bpToggleVelo(){bpVeloOn=!bpVeloOn;const b=document.getElementById('bpVeloToggle');if(b){b.classList.toggle('on',bpVeloOn);b.innerHTML=bpVeloOn?'<svg class="icon"><use href="#i-bolt"/></svg> Exit velo: ON':'<svg class="icon"><use href="#i-bolt"/></svg> Exit velo: off';}}
function bpNewRound(){const label=prompt('Round label (e.g. "Free swings", "Oppo / situational"):','Round '+(bpRounds.length+1));if(label===null)return;bpRounds.push({label:label||('Round '+(bpRounds.length+1)),swings:[]});renderSkill();}
function bpTap(r){
  if(!bpRounds.length)bpRounds.push({label:'Round 1',swings:[]});
  let v=null;
  if(bpVeloOn){const raw=prompt('Exit velo (mph) — leave blank to skip:');if(raw!==null&&raw.trim()!==''){const p=parseFloat(raw);if(p>0)v=Math.round(p*10)/10;}}
  bpRounds[bpRounds.length-1].swings.push({r:r,v:v});
  renderSkill();
}
function bpUndo(){const r=bpRounds[bpRounds.length-1];if(r&&r.swings.length)r.swings.pop();else if(bpRounds.length&&!bpRounds[bpRounds.length-1].swings.length)bpRounds.pop();renderSkill();}

function renderSkill(){
  if(trackMode==='pop'){
    const best=popThrows.length?Math.min(...popThrows.map(x=>x.t)):null;
    document.getElementById('popRows').innerHTML=popThrows.map((x,i)=>
      '<div class="skl-row"><span class="skl-n">'+(i+1)+'</span><span class="skl-time'+(x.t===best?' best':'')+'">'+x.t.toFixed(2)+'</span><span class="skl-tgt">→ '+x.target+'</span>'
      +'<span class="skl-okx"><button class="'+(x.ok===true?'on1':'')+'" onclick="popMark('+i+',true)">✓</button><button class="'+(x.ok===false?'on0':'')+'" onclick="popMark('+i+',false)">✗</button></span>'
      +'<button class="skl-del" onclick="popDel('+i+')">✕</button></div>').join('');
    const marked=popThrows.filter(x=>x.ok!==null),on=popThrows.filter(x=>x.ok===true).length;
    document.getElementById('popSummary').innerHTML=popThrows.length?
      '<div><b>'+(popThrows.reduce((s,x)=>s+x.t,0)/popThrows.length).toFixed(2)+'</b><span>avg pop</span></div>'
      +'<div><b>'+best.toFixed(2)+'</b><span>best</span></div>'
      +'<div><b>'+on+'/'+marked.length+'</b><span>on target</span></div>':'';
  }else if(trackMode==='sprint'){
    const times=sprintReps.map(x=>x.t);
    const best=times.length?Math.min(...times):null;
    document.getElementById('sprintRows').innerHTML=sprintReps.map((x,i)=>
      '<div class="skl-row"><span class="skl-n">'+(i+1)+'</span><span class="skl-time'+(x.t===best?' best':'')+'">'+x.t.toFixed(2)+'</span><span class="skl-tgt">'+x.d+'</span>'
      +'<button class="skl-del" onclick="sprintDel('+i+')">✕</button></div>').join('');
    document.getElementById('sprintSummary').innerHTML=times.length?
      '<div><b>'+best.toFixed(2)+'</b><span>best sprint</span></div>'
      +'<div><b>'+(times.reduce((s,t)=>s+t,0)/times.length).toFixed(2)+'</b><span>avg sprint</span></div>'
      +'<div><b>'+times.length+'</b><span>sprints</span></div>':'';
  }else if(trackMode==='bp'){
    document.getElementById('bpRows').innerHTML=bpRounds.map(r=>
      '<div class="bp-round"><div class="bp-rt"><span>'+r.label+'</span><span>'+r.swings.length+' swings</span></div>'
      +'<div class="bp-swings">'+r.swings.map(s=>{var res=bpSwingResult(s),v=bpSwingVelo(s);return '<span class="sw '+res.toLowerCase()+'"'+(v!=null?' title="'+v+' mph"':'')+'>'+res+(v!=null?'<i>'+v+'</i>':'')+'</span>';}).join('')+'</div></div>').join('')
      +(bpRounds.length?'<button class="btn-action" style="margin:6px 0 0 12px;" onclick="bpUndo()">↩ Undo swing</button>':'');
    const all=bpRounds.flatMap(r=>r.swings),h=all.filter(s=>bpSwingResult(s)==='H').length,m=all.filter(s=>bpSwingResult(s)==='M').length;
    const velos=all.map(bpSwingVelo).filter(v=>v!=null);
    document.getElementById('bpSummary').innerHTML=all.length?
      '<div><b>'+Math.round(h/all.length*100)+'%</b><span>hard %</span></div><div><b>'+m+'</b><span>misses</span></div><div><b>'+all.length+'</b><span>swings</span></div>'
      +(velos.length?'<div><b>'+Math.max(...velos).toFixed(1)+'</b><span>top EV</span></div><div><b>'+(velos.reduce((s,v)=>s+v,0)/velos.length).toFixed(1)+'</b><span>avg EV</span></div>':''):'';
  }
}

function setSkillStatus(m,t){const el=document.getElementById('skillStatus');el.textContent=m;el.className='skill-status'+(t?' '+t:'');}
async function saveSkillSession(){
  const player=document.getElementById('skillPlayer').value;
  const date=document.getElementById('skillDate').value;
  if(document.getElementById('skillPin').value.trim()!=='2149'){setSkillStatus('Incorrect PIN','error');return;}
  if(!player||!date){setSkillStatus('Select a player and date','error');return;}
  let data;
  if(trackMode==='pop'){if(!popThrows.length){setSkillStatus('No throws recorded','error');return;}data={throws:popThrows};}
  else if(trackMode==='sprint'){if(!sprintReps.length){setSkillStatus('No sprints recorded','error');return;}data={sprints:sprintReps};}
  else{if(!bpRounds.some(r=>r.swings.length)){setSkillStatus('No swings recorded','error');return;}data={rounds:bpRounds};}
  setSkillStatus('Saving…','');
  const res=await gasJsonp(getSavedUrl(),{action:'save_skill_session',player,date,kind:trackMode,data:JSON.stringify(data)});
  if(res&&res.success){
    setSkillStatus('','');showToast('Session saved ✓');
    if(trackMode==='pop')popThrows=[];else if(trackMode==='sprint')sprintReps=[];else bpRounds=[];
    document.getElementById('skillPin').value='';
    renderSkill();loadSkillRecent();
  }else setSkillStatus((res&&res.error)||'Save failed','error');
}

async function loadSkillRecent(){
  const el=document.getElementById('skillRecent');if(!el)return;
  const player=document.getElementById('skillPlayer').value;
  el.innerHTML='';
  if(!player)return;
  const res=await gasJsonp(getSavedUrl(),{action:'fetch_skill_sessions',player,kind:trackMode,limit:3});
  if(!(res&&res.success&&res.data&&res.data.length))return;
  el.innerHTML='<div class="brd-rec-title">Recent '+({pop:'pop-time',sprint:'sprint',bp:'BP'})[trackMode]+' sessions — '+player+'</div>'
    +res.data.map(s=>{
      let sum='';
      if(s.kind==='pop'&&s.data.throws){const ts=s.data.throws.map(x=>x.t);sum='best '+Math.min(...ts).toFixed(2)+' · avg '+(ts.reduce((a,b)=>a+b,0)/ts.length).toFixed(2)+' · '+ts.length+' throws';}
      else if(s.kind==='sprint'){const arr=s.data.sprints||s.data.runs||[];const ts=arr.map(x=>x.t);if(ts.length)sum='best '+Math.min(...ts).toFixed(2)+' · avg '+(ts.reduce((a,b)=>a+b,0)/ts.length).toFixed(2)+' · '+ts.length+' sprints';}
      else if(s.kind==='bp'&&s.data.rounds){const all=s.data.rounds.flatMap(r=>r.swings);const res=all.map(x=>(x&&typeof x==='object')?x.r:x);const h=res.filter(x=>x==='H').length;const velos=all.map(x=>(x&&typeof x==='object')?x.v:null).filter(v=>v!=null);sum=(all.length?Math.round(h/all.length*100):0)+'% hard · '+all.length+' swings'+(velos.length?' · '+Math.max(...velos).toFixed(1)+' top EV':'');}
      return '<div class="brd-rec-row"><span>'+fmtMD(s.date)+'</span><span>'+sum+'</span></div>';
    }).join('');
}
document.addEventListener('change',e=>{if(e.target&&e.target.id==='skillPlayer')loadSkillRecent();});

/* ── Team Settings (PIN-gated; hosts Start New Season + rest rules) ── */
function openSettingsModal(){
  document.getElementById('waffleMenu').classList.remove('open');
  document.getElementById('settingsPin').value='';
  document.getElementById('settingsBody').style.display='none';
  document.getElementById('settingsPinField').style.display='block';
  document.getElementById('settingsUnlockBtn').style.display='';
  setSettingsStatus('','');
  document.getElementById('settingsModal').classList.add('open');
}
function closeSettingsModal(){document.getElementById('settingsModal').classList.remove('open');}
function setSettingsStatus(m,t){const el=document.getElementById('settingsStatus');el.textContent=m;el.className='modal-status'+(t?' '+t:'');}
async function unlockSettings(){
  if(document.getElementById('settingsPin').value.trim()!=='2149'){setSettingsStatus('Incorrect PIN code','error');return;}
  setSettingsStatus('','');
  document.getElementById('settingsPinField').style.display='none';
  document.getElementById('settingsUnlockBtn').style.display='none';
  document.getElementById('settingsBody').style.display='block';
  try{await fetchBoardData(true);}catch(e){}
  renderRulesGrid();
}
function renderRulesGrid(){
  const r=boardRules||BOARD_DEFAULT_RULES;
  let lo=1;
  document.getElementById('rulesGrid').innerHTML=
    r.tiers.map((t,i)=>{const html='<label>'+lo+'–<input type="number" data-tier="'+i+'" data-f="max" value="'+t[0]+'"> p → <input type="number" data-tier="'+i+'" data-f="rest" value="'+t[1]+'"> days</label>';lo=t[0]+1;return html;}).join('')
    +'<label>Daily max <input type="number" id="ruleMaxDaily" value="'+r.maxDaily+'"></label>'
    +'<label>Playoff max <input type="number" id="ruleMaxPlayoff" value="'+r.maxPlayoff+'"></label>';
}
async function saveBoardRules(){
  const r=JSON.parse(JSON.stringify(boardRules||BOARD_DEFAULT_RULES));
  document.querySelectorAll('#rulesGrid input[data-tier]').forEach(inp=>{
    const i=+inp.dataset.tier;r.tiers[i][inp.dataset.f==='max'?0:1]=+inp.value||r.tiers[i][inp.dataset.f==='max'?0:1];
  });
  r.maxDaily=+document.getElementById('ruleMaxDaily').value||r.maxDaily;
  r.maxPlayoff=+document.getElementById('ruleMaxPlayoff').value||r.maxPlayoff;
  const st=document.getElementById('rulesStatus');
  st.textContent='Saving…';st.className='skill-status';
  const res=await gasJsonp(getSavedUrl(),{action:'save_board_config',rules:JSON.stringify(r)});
  if(res&&res.success){boardRules=r;st.textContent='Saved ✓';st.className='skill-status ok';renderBoard();}
  else{st.textContent=(res&&res.error)||'Save failed';st.className='skill-status error';}
}

/* ── Player card cross-links ── */
function pcAddVideo(){
  const name=(typeof playerCardCurrentName!=='undefined'&&playerCardCurrentName)||document.getElementById('playerCardName').textContent.trim();
  if(typeof openVideoMgr==='function'){
    openVideoMgr();
    setTimeout(()=>{const sel=document.getElementById('vmgrPitcher');if(sel){if(![...sel.options].some(o=>o.value===name)){const op=document.createElement('option');op.value=name;op.textContent=name;sel.appendChild(op);}sel.value=name;}},80);
  }
}

/* boot: default tab highlight */
document.addEventListener('DOMContentLoaded',()=>{syncTabbar(currentView);});

function toggleBoardMore(ev){
  if(ev)ev.stopPropagation();
  const el=document.getElementById('boardMore');
  if(el)el.style.display=el.style.display==='none'?'':'none';
}
