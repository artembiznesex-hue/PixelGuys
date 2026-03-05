/**
 * OkakPix Server
 * - Binary WS protocol (pixelplanet opcodes)
 * - Registration/Login
 * - Stack cooldown (no CD if placing same color as existing pixel)
 * - Admin: no cooldown
 * - earth.png loaded at native resolution
 */
'use strict';

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

// ── CANVAS CONFIG ──────────────────────────────────────────
const TILE_SIZE   = 256;
const MAX_STACK   = 120;
const REGEN_MS    = 1000;

// Will be set after reading earth.png
let CANVAS_SIZE = 4096;
let TILES       = CANVAS_SIZE / TILE_SIZE;

// ── PALETTE (32 colors, pixelplanet canvases.json) ─────────
const PALETTE = [
  [202,227,255],[255,255,255],[255,255,255],[228,228,228],
  [196,196,196],[136,136,136],[78,78,78],[0,0,0],
  [244,179,174],[255,167,209],[255,84,178],[255,101,101],
  [229,0,0],[154,0,0],[254,164,96],[229,149,0],
  [160,106,66],[96,64,40],[245,223,176],[255,248,137],
  [229,217,0],[148,224,68],[2,190,1],[104,131,56],
  [0,101,19],[202,227,255],[0,211,221],[0,131,199],
  [0,0,234],[25,25,115],[207,110,228],[130,0,128],
];

// ── CHUNK STORAGE ──────────────────────────────────────────
let chunks = null; // Array of Uint8Array, indexed [cj*TILES+ci]

function initChunks() {
  TILES = CANVAS_SIZE / TILE_SIZE;
  chunks = new Array(TILES * TILES);
  for (let i = 0; i < chunks.length; i++) {
    chunks[i] = new Uint8Array(TILE_SIZE * TILE_SIZE);
  }
  console.log(`[Canvas] Initialized ${TILES}x${TILES} chunks for ${CANVAS_SIZE}x${CANVAS_SIZE} canvas`);
}

function ci2idx(ci, cj) { return cj * TILES + ci; }

function getColorIdx(x, y) {
  const ci = Math.floor(x / TILE_SIZE);
  const cj = Math.floor(y / TILE_SIZE);
  return chunks[ci2idx(ci, cj)][(y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE)];
}

function setColorIdx(x, y, idx) {
  const ci = Math.floor(x / TILE_SIZE);
  const cj = Math.floor(y / TILE_SIZE);
  chunks[ci2idx(ci, cj)][(y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE)] = idx;
}

// ── PALETTE NEAREST ────────────────────────────────────────
function nearestColor(r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 2; i < PALETTE.length; i++) { // skip 0,1 (bg/transparent)
    const [pr,pg,pb] = PALETTE[i];
    const d = (r-pr)**2 + (g-pg)**2 + (b-pb)**2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ── LOAD EARTH.PNG ─────────────────────────────────────────
async function loadEarth() {
  const earthPath = path.join(__dirname, 'earth.png');
  if (!fs.existsSync(earthPath)) {
    console.log('[Canvas] earth.png not found, using blank canvas 1024x1024');
    CANVAS_SIZE = 1024;
    initChunks();
    loadSavedState();
    return;
  }
  try {
    const sharp = require('sharp');
    const meta = await sharp(earthPath).metadata();
    console.log(`[Canvas] earth.png: ${meta.width}x${meta.height}`);

    // Use native resolution rounded down to TILE_SIZE multiple
    CANVAS_SIZE = Math.min(
      Math.floor(meta.width / TILE_SIZE) * TILE_SIZE,
      Math.floor(meta.height / TILE_SIZE) * TILE_SIZE
    );
    if (CANVAS_SIZE < TILE_SIZE) CANVAS_SIZE = TILE_SIZE;
    console.log(`[Canvas] Using canvas size: ${CANVAS_SIZE}x${CANVAS_SIZE}`);

    initChunks();

    // Fast path: if saved state exists with matching size, load it (already has earth.png baked in)
    if (fs.existsSync(STATE_FILE) && fs.existsSync(META_FILE)) {
      try {
        const savedMeta = JSON.parse(fs.readFileSync(META_FILE,'utf8'));
        if (savedMeta.CANVAS_SIZE === CANVAS_SIZE) {
          // Check if saved state is just all zeros (empty/ocean) - if so, skip it and re-quantize
          const buf = fs.readFileSync(STATE_FILE);
          const expected = TILES * TILES * TILE_SIZE * TILE_SIZE;
          let nonZero = 0;
          for (let i = 0; i < Math.min(buf.length, 10000); i++) { if (buf[i] !== 0) nonZero++; }
          if (buf.length === expected && nonZero > 100) {
            loadSavedState();
            console.log('[Canvas] Loaded from saved state (fast path) ✓');
            return;
          } else {
            console.log('[Canvas] Saved state appears empty, will re-quantize earth.png');
          }
        }
      } catch(e) {}
    }

    // Slow path: quantize earth.png (first run or size changed)
    console.log('[Canvas] Quantizing earth.png...');
    const { data, info } = await sharp(earthPath)
      .resize(CANVAS_SIZE, CANVAS_SIZE, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const ch = info.channels;
    for (let py = 0; py < CANVAS_SIZE; py++) {
      if (py % 256 === 0) process.stdout.write(`\r[Canvas] Quantizing... ${Math.round(py/CANVAS_SIZE*100)}%`);
      for (let px = 0; px < CANVAS_SIZE; px++) {
        const pi = (py * CANVAS_SIZE + px) * ch;
        const idx = nearestColor(data[pi], data[pi+1], data[pi+2]);
        setColorIdx(px, py, idx);
      }
    }
    process.stdout.write('\n');
    console.log('[Canvas] earth.png quantized ✓');
    // Save immediately so next restart is fast
    saveState();
    console.log('[Canvas] Base state saved ✓');
    // Don't call loadSavedState - we just built the state fresh
    return;

  } catch(e) {
    console.error('[Canvas] sharp error:', e.message);
    console.log('[Canvas] Falling back to blank canvas');
    CANVAS_SIZE = 1024;
    initChunks();
  }

  // Apply saved player changes ON TOP of the earth.png base
  loadSavedState();
}

// ── PERSIST ────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'canvas_state.bin');
const META_FILE  = path.join(__dirname, 'canvas_meta.json');

function saveState() {
  try {
    const total = TILES * TILES * TILE_SIZE * TILE_SIZE;
    const buf = Buffer.allocUnsafe(total);
    for (let ci = 0; ci < TILES; ci++) {
      for (let cj = 0; cj < TILES; cj++) {
        buf.set(chunks[ci2idx(ci,cj)], (cj*TILES+ci) * TILE_SIZE * TILE_SIZE);
      }
    }
    fs.writeFileSync(STATE_FILE, buf);
    fs.writeFileSync(META_FILE, JSON.stringify({ CANVAS_SIZE, TILE_SIZE, TILES }));
  } catch(e) { console.error('[Save]', e.message); }
}

function loadSavedState() {
  if (!fs.existsSync(STATE_FILE) || !fs.existsSync(META_FILE)) return;
  try {
    const meta = JSON.parse(fs.readFileSync(META_FILE,'utf8'));
    if (meta.CANVAS_SIZE !== CANVAS_SIZE) { console.log('[Canvas] Saved state size mismatch, skipping'); return; }
    const buf = fs.readFileSync(STATE_FILE);
    const expected = TILES * TILES * TILE_SIZE * TILE_SIZE;
    if (buf.length !== expected) return;
    for (let ci = 0; ci < TILES; ci++) {
      for (let cj = 0; cj < TILES; cj++) {
        const off = (cj*TILES+ci) * TILE_SIZE * TILE_SIZE;
        chunks[ci2idx(ci,cj)].set(buf.slice(off, off + TILE_SIZE*TILE_SIZE));
      }
    }
    console.log('[Canvas] Saved state restored ✓');
  } catch(e) { console.error('[LoadState]', e.message); }
}

setInterval(saveState, 30000);

// ── USERS ──────────────────────────────────────────────────
const USERS_FILE = path.join(__dirname, 'users.json');
let users = {};

function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    try { users = JSON.parse(fs.readFileSync(USERS_FILE,'utf8')); } catch(e) {}
  }
  if (!users['admin']) {
    users['admin'] = { password: 'admin', noCooldown: true, totalPixels: 0 };
    saveUsers();
  }
}
function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ── WS ─────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws', perMessageDeflate: false });
const clients = new Map(); // ws → client state

function getOnline() { return clients.size; }

// Binary packet builders
function pktPixelUpdate(ci, cj, offset, colorIdx) {
  const b = Buffer.allocUnsafe(7);
  b[0]=0xC1; b[1]=ci; b[2]=cj;
  b[3]=offset>>>16; b.writeUInt16BE(offset&0xFFFF,4); b[6]=colorIdx;
  return b;
}
function pktCooldown(secs) {
  const b=Buffer.allocUnsafe(3); b[0]=0xC2; b.writeUInt16BE(secs,1); return b;
}
function pktOnline(n) {
  const b=Buffer.allocUnsafe(3); b[0]=0xA7; b.writeInt16BE(n,1); return b;
}

function broadcastOnline() {
  const p = pktOnline(getOnline());
  for (const [ws] of clients) { if(ws.readyState===1) ws.send(p); }
}
function broadcastPixel(ci, cj, offset, colorIdx) {
  const p = pktPixelUpdate(ci, cj, offset, colorIdx);
  const id = (ci<<8)|cj;
  for (const [ws,cl] of clients) {
    if (ws.readyState===1 && cl.chunks.has(id)) ws.send(p);
  }
}

wss.on('connection', (ws) => {
  const cl = { username:null, stack:MAX_STACK, lastRegen:Date.now(), noCooldown:false, chunks:new Set() };
  clients.set(ws, cl);
  broadcastOnline();

  ws.on('message', (data) => {
    if (typeof data === 'string') handleText(ws, cl, data);
    else handleBinary(ws, cl, Buffer.from(data));
  });
  ws.on('close', () => { clients.delete(ws); broadcastOnline(); });
  ws.on('error', () => clients.delete(ws));
});

// ── TEXT MESSAGES ──────────────────────────────────────────
function handleText(ws, cl, raw) {
  let msg; try { msg=JSON.parse(raw); } catch { return; }
  switch(msg.type) {
    case 'login':    return doLogin(ws, cl, msg);
    case 'register': return doRegister(ws, cl, msg);
    case 'pixel':    return doPixel(ws, cl, msg);
    case 'chat':     return doChat(ws, cl, msg);
  }
}

function send(ws, obj) { if(ws.readyState===1) ws.send(JSON.stringify(obj)); }

function doLogin(ws, cl, {username, password}) {
  if (!username||!password) return send(ws,{type:'auth_fail',reason:'Заповніть всі поля'});
  const u = users[username];
  if (!u) return send(ws,{type:'auth_fail',reason:'Користувача не знайдено'});
  if (u.password !== password) return send(ws,{type:'auth_fail',reason:'Невірний пароль'});
  cl.username=username; cl.noCooldown=!!u.noCooldown;
  if (cl.noCooldown) cl.stack = MAX_STACK;
  send(ws,{type:'auth_ok', username, noCooldown:cl.noCooldown, stack:cl.stack, totalPixels:u.totalPixels||0});
  console.log(`[Auth] Login: ${username}`);
}

function doRegister(ws, cl, {username, password}) {
  if (!username||!password) return send(ws,{type:'auth_fail',reason:'Заповніть всі поля'});
  username = username.trim();
  if (username.length<3) return send(ws,{type:'auth_fail',reason:'Нікнейм мінімум 3 символи'});
  if (password.length<4) return send(ws,{type:'auth_fail',reason:'Пароль мінімум 4 символи'});
  if (users[username]) return send(ws,{type:'auth_fail',reason:'Нікнейм вже зайнятий'});
  users[username]={password, noCooldown:false, totalPixels:0};
  saveUsers();
  cl.username=username; cl.noCooldown=false; cl.stack=MAX_STACK;
  send(ws,{type:'auth_ok', username, noCooldown:false, stack:MAX_STACK, totalPixels:0});
  console.log(`[Auth] Register: ${username}`);
}

function doChat(ws, cl, {text}) {
  if (!cl.username) return send(ws, {type:'error', reason:'Login required'});
  if (!text || typeof text !== 'string') return;
  text = text.trim().slice(0, 200);
  if (!text) return;
  const msg = JSON.stringify({type:'chat', username: cl.username, text});
  for (const [cws] of clients) { if(cws.readyState===1) cws.send(msg); }
}

function doPixel(ws, cl, {x, y, colorIdx, brushSize}) {
  if (!cl.username) return send(ws,{type:'error',reason:'Login required'});
  brushSize = Math.min(Math.max(1, brushSize||1), 8); // clamp 1-8

  // Collect pixels to place (brush)
  const half = Math.floor(brushSize/2);
  const toPlace = [];
  for (let dy=0; dy<brushSize; dy++) {
    for (let dx=0; dx<brushSize; dx++) {
      const px = x - half + dx;
      const py = y - half + dy;
      if (px>=0 && py>=0 && px<CANVAS_SIZE && py<CANVAS_SIZE) {
        // Don't cost CD if pixel is already this color
        const existing = getColorIdx(px, py);
        toPlace.push({px, py, free: existing === colorIdx});
      }
    }
  }

  // Count non-free pixels
  const costPixels = toPlace.filter(p=>!p.free).length;

  if (!cl.noCooldown) {
    regenStack(cl);
    if (cl.stack < costPixels && costPixels > 0) {
      ws.send(pktCooldown(Math.ceil((costPixels - cl.stack) * REGEN_MS / 1000)));
      send(ws,{type:'stack_empty'});
      return;
    }
    cl.stack = Math.max(0, cl.stack - costPixels);
    send(ws,{type:'stack_update', stack:cl.stack});
  }

  // Apply pixels
  for (const {px, py} of toPlace) {
    const ci = Math.floor(px/TILE_SIZE);
    const cj = Math.floor(py/TILE_SIZE);
    const offset = (py%TILE_SIZE)*TILE_SIZE + (px%TILE_SIZE);
    setColorIdx(px, py, colorIdx);
    broadcastPixel(ci, cj, offset, colorIdx);
  }

  if (users[cl.username]) {
    users[cl.username].totalPixels = (users[cl.username].totalPixels||0) + toPlace.length;
  }
}

// ── BINARY MESSAGES (chunk registration) ───────────────────
function handleBinary(ws, cl, buf) {
  if (!buf.length) return;
  const op = buf[0];
  if (op === 0xA1) { // REG_CHUNK
    const ci = buf[1], cj = buf[2];
    if (ci>=0 && cj>=0 && ci<TILES && cj<TILES) {
      cl.chunks.add((ci<<8)|cj);
      // Send chunk data
      const chunk = chunks[ci2idx(ci,cj)];
      send(ws, {type:'chunk', ci, cj, data: Buffer.from(chunk).toString('base64')});
    }
  } else if (op === 0xA5) { // DEREG_CHUNK
    cl.chunks.delete((buf[1]<<8)|buf[2]);
  }
}

function regenStack(cl) {
  const now = Date.now();
  const add = Math.floor((now-cl.lastRegen)/REGEN_MS);
  if (add>0 && cl.stack<MAX_STACK) {
    cl.stack = Math.min(MAX_STACK, cl.stack+add);
    cl.lastRegen = now - ((now-cl.lastRegen)%REGEN_MS);
  }
}

// ── HTTP ───────────────────────────────────────────────────
app.use(express.static(__dirname));

app.get('/api/canvas', (req, res) => {
  res.json({ size:CANVAS_SIZE, tileSize:TILE_SIZE, tiles:TILES, maxStack:MAX_STACK, regenMs:REGEN_MS, palette:PALETTE });
});

app.get('/chunk/:ci/:cj', (req, res) => {
  const ci=+req.params.ci, cj=+req.params.cj;
  if (isNaN(ci)||isNaN(cj)||ci<0||cj<0||ci>=TILES||cj>=TILES) return res.status(404).end();
  res.setHeader('Content-Type','application/octet-stream');
  res.setHeader('Cache-Control','no-cache');
  res.send(Buffer.from(chunks[ci2idx(ci,cj)]));
});

setInterval(broadcastOnline, 10000);

// ── START ──────────────────────────────────────────────────
loadUsers();
loadEarth().then(() => {
  server.listen(PORT, () => {
    console.log(`\n✅ OkakPix running → http://localhost:${PORT}`);
    console.log(`   Canvas: ${CANVAS_SIZE}×${CANVAS_SIZE} | Chunks: ${TILES}×${TILES}`);
  });
});
