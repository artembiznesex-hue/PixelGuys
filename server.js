/**
 * OkakPix Server — pixelplanet-style binary WebSocket protocol
 * Binary opcodes same as pixelplanet:
 *   0xC1 = PixelUpdate  (chunk-based, i j offset color)
 *   0xC2 = CoolDown     (uint16 waitSeconds)
 *   0xA7 = OnlineCounter (int16 online)
 *   0xA0 = RegisterCanvas
 *   0xA1 = RegisterChunk
 *   0xA5 = DeRegisterChunk
 *
 * Canvas: 1024×1024, tile size 256 → 4×4 = 16 chunks
 */

'use strict';

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');

const app    = express();
const server = http.createServer(app);

// ── CONSTANTS ──────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const CANVAS_SIZE = 1024;          // px width & height
const TILE_SIZE   = 256;           // chunk size (same as pixelplanet)
const TILES       = CANVAS_SIZE / TILE_SIZE; // 4×4 = 16 chunks
const MAX_STACK   = 120;           // max pixels in stack
const REGEN_MS    = 1000;          // +1 pixel per second
const BCD         = 0;             // base cooldown ms (stack system: 0)
const CANVAS_ID   = 0;

// Binary opcodes (same as pixelplanet)
const OP = {
  PIXEL_UPDATE:   0xC1,
  COOLDOWN:       0xC2,
  ONLINE_COUNTER: 0xA7,
  REG_CANVAS:     0xA0,
  REG_CHUNK:      0xA1,
  DEREG_CHUNK:    0xA5,
};

// ── PALETTE (32 colors from pixelplanet canvases.json) ─────
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

// ── CANVAS STATE ───────────────────────────────────────────
// Store as flat array of color indices (1 byte per pixel)
const TOTAL_PIXELS = CANVAS_SIZE * CANVAS_SIZE;
let canvasColors = new Uint8Array(TOTAL_PIXELS); // color index per pixel

// Chunks: each chunk is a Uint8Array of TILE_SIZE*TILE_SIZE color indices
const chunks = new Array(TILES * TILES);
for (let i = 0; i < TILES * TILES; i++) {
  chunks[i] = new Uint8Array(TILE_SIZE * TILE_SIZE);
}

function chunkIndex(ci, cj) { return cj * TILES + ci; }

function getPixelColorIndex(x, y) {
  const ci = Math.floor(x / TILE_SIZE);
  const cj = Math.floor(y / TILE_SIZE);
  const lx = x % TILE_SIZE;
  const ly = y % TILE_SIZE;
  return chunks[chunkIndex(ci, cj)][ly * TILE_SIZE + lx];
}

function setPixelColorIndex(x, y, colorIdx) {
  const ci = Math.floor(x / TILE_SIZE);
  const cj = Math.floor(y / TILE_SIZE);
  const lx = x % TILE_SIZE;
  const ly = y % TILE_SIZE;
  chunks[chunkIndex(ci, cj)][ly * TILE_SIZE + lx] = colorIdx;
}

// ── EARTH.PNG LOADING ──────────────────────────────────────
function loadEarth() {
  const earthPath = path.join(__dirname, 'earth.png');
  if (!fs.existsSync(earthPath)) {
    console.log('[Canvas] earth.png not found, blank canvas');
    return;
  }
  try {
    const sharp = require('sharp');
    sharp(earthPath)
      .resize(CANVAS_SIZE, CANVAS_SIZE, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true })
      .then(({ data, info }) => {
        const ch = info.channels; // 3 or 4
        for (let py = 0; py < CANVAS_SIZE; py++) {
          for (let px = 0; px < CANVAS_SIZE; px++) {
            const pi = (py * CANVAS_SIZE + px) * ch;
            const r = data[pi], g = data[pi+1], b = data[pi+2];
            // Find nearest palette color
            const idx = nearestPaletteColor(r, g, b);
            setPixelColorIndex(px, py, idx);
          }
        }
        console.log(`[Canvas] earth.png loaded & quantized to palette`);
        // Load saved edits on top
        loadSavedState();
      })
      .catch(e => { console.error('[Canvas] sharp error:', e.message); loadSavedState(); });
  } catch(e) {
    console.log('[Canvas] sharp not available, loading saved state only');
    loadSavedState();
  }
}

function nearestPaletteColor(r, g, b) {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < PALETTE.length; i++) {
    const [pr, pg, pb] = PALETTE[i];
    const d = (r-pr)**2 + (g-pg)**2 + (b-pb)**2;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

// ── PERSIST CANVAS ─────────────────────────────────────────
const STATE_PATH = path.join(__dirname, 'canvas_state.bin');

function saveState() {
  // Save all chunk data concatenated
  const buf = Buffer.allocUnsafe(TILES * TILES * TILE_SIZE * TILE_SIZE);
  for (let ci = 0; ci < TILES; ci++) {
    for (let cj = 0; cj < TILES; cj++) {
      const chunk = chunks[chunkIndex(ci, cj)];
      const offset = (cj * TILES + ci) * TILE_SIZE * TILE_SIZE;
      buf.set(chunk, offset);
    }
  }
  fs.writeFileSync(STATE_PATH, buf);
}

function loadSavedState() {
  if (!fs.existsSync(STATE_PATH)) return;
  try {
    const buf = fs.readFileSync(STATE_PATH);
    if (buf.length !== TILES * TILES * TILE_SIZE * TILE_SIZE) return;
    for (let ci = 0; ci < TILES; ci++) {
      for (let cj = 0; cj < TILES; cj++) {
        const offset = (cj * TILES + ci) * TILE_SIZE * TILE_SIZE;
        chunks[chunkIndex(ci, cj)].set(buf.slice(offset, offset + TILE_SIZE * TILE_SIZE));
      }
    }
    console.log('[Canvas] Saved state restored');
  } catch(e) { console.error('[Canvas] Failed to load state:', e.message); }
}

setInterval(saveState, 30000);

// ── USERS ──────────────────────────────────────────────────
const USERS_PATH = path.join(__dirname, 'users.json');
let users = {}; // name → { password, noCooldown, totalPixels }

function loadUsers() {
  if (fs.existsSync(USERS_PATH)) {
    try { users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); } catch(e) {}
  }
  if (!users['admin']) {
    users['admin'] = { password: 'admin', noCooldown: true, totalPixels: 0 };
    saveUsers();
  }
}

function saveUsers() {
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
}

// ── SESSIONS ───────────────────────────────────────────────
const sessions = new Map(); // token → username

function makeToken() { return crypto.randomBytes(16).toString('hex'); }

// ── WS SERVER ──────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws', perMessageDeflate: false });

// client state
const clients = new Map(); // ws → { username, stack, lastRegen, noCooldown, registeredChunks }

function getOnline() { return clients.size; }

// ── BINARY PACKET BUILDERS ─────────────────────────────────
function buildPixelUpdate(ci, cj, offset, colorIdx) {
  const buf = Buffer.allocUnsafe(7);
  buf.writeUInt8(OP.PIXEL_UPDATE, 0);
  buf.writeUInt8(ci, 1);
  buf.writeUInt8(cj, 2);
  buf.writeUInt8(offset >>> 16, 3);
  buf.writeUInt16BE(offset & 0xFFFF, 4);
  buf.writeUInt8(colorIdx, 6);
  return buf;
}

function buildCooldown(waitSeconds) {
  const buf = Buffer.allocUnsafe(3);
  buf.writeUInt8(OP.COOLDOWN, 0);
  buf.writeUInt16BE(waitSeconds, 1);
  return buf;
}

function buildOnlineCounter(n) {
  const buf = Buffer.allocUnsafe(3);
  buf.writeUInt8(OP.ONLINE_COUNTER, 0);
  buf.writeInt16BE(n, 1);
  return buf;
}

// ── BROADCAST ──────────────────────────────────────────────
function broadcastOnline() {
  const buf = buildOnlineCounter(getOnline());
  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(buf);
  }
}

function broadcastPixel(ci, cj, offset, colorIdx) {
  const buf = buildPixelUpdate(ci, cj, offset, colorIdx);
  const chunkId = (ci << 8) | cj;
  for (const [ws, cl] of clients) {
    if (ws.readyState === WebSocket.OPEN && cl.registeredChunks.has(chunkId)) {
      ws.send(buf);
    }
  }
}

// ── WS CONNECTIONS ─────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const cl = {
    username: null,
    stack: MAX_STACK,
    lastRegen: Date.now(),
    noCooldown: false,
    registeredChunks: new Set(),
  };
  clients.set(ws, cl);
  broadcastOnline();

  ws.on('message', (data) => {
    if (typeof data === 'string') {
      handleText(ws, cl, data);
    } else {
      handleBinary(ws, cl, Buffer.from(data));
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastOnline();
  });

  ws.on('error', () => clients.delete(ws));
});

// ── TEXT PROTOCOL (auth + pixel placement JSON) ─────────────
function handleText(ws, cl, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  switch (msg.type) {
    case 'login': return authLogin(ws, cl, msg);
    case 'register': return authRegister(ws, cl, msg);
    case 'pixel': return handlePixelJSON(ws, cl, msg);
    default: break;
  }
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function authLogin(ws, cl, { username, password }) {
  if (!username || !password) return send(ws, { type:'auth_fail', reason:'Заповніть всі поля' });
  const u = users[username];
  if (!u) return send(ws, { type:'auth_fail', reason:'Користувача не знайдено' });
  if (u.password !== password) return send(ws, { type:'auth_fail', reason:'Невірний пароль' });
  cl.username = username;
  cl.noCooldown = !!u.noCooldown;
  cl.stack = cl.noCooldown ? MAX_STACK : Math.min(MAX_STACK, cl.stack);
  send(ws, { type:'auth_ok', username, noCooldown: cl.noCooldown, stack: cl.stack, totalPixels: u.totalPixels||0 });
}

function authRegister(ws, cl, { username, password }) {
  if (!username || !password) return send(ws, { type:'auth_fail', reason:'Заповніть всі поля' });
  if (username.length < 3) return send(ws, { type:'auth_fail', reason:'Нікнейм мінімум 3 символи' });
  if (password.length < 4) return send(ws, { type:'auth_fail', reason:'Пароль мінімум 4 символи' });
  if (users[username]) return send(ws, { type:'auth_fail', reason:'Нікнейм вже зайнятий' });
  users[username] = { password, noCooldown: false, totalPixels: 0 };
  saveUsers();
  cl.username = username;
  cl.noCooldown = false;
  send(ws, { type:'auth_ok', username, noCooldown: false, stack: MAX_STACK, totalPixels: 0 });
}

function handlePixelJSON(ws, cl, { x, y, colorIdx }) {
  if (!cl.username) return send(ws, { type:'error', reason:'Login required' });
  if (colorIdx < 0 || colorIdx >= PALETTE.length) return;
  if (x < 0 || y < 0 || x >= CANVAS_SIZE || y >= CANVAS_SIZE) return;

  // Stack check
  if (!cl.noCooldown) {
    regenStack(cl);
    if (cl.stack <= 0) {
      ws.send(buildCooldown(REGEN_MS / 1000));
      return send(ws, { type:'stack_empty' });
    }
    cl.stack--;
    send(ws, { type:'stack_update', stack: cl.stack });
  }

  // Apply
  const ci = Math.floor(x / TILE_SIZE);
  const cj = Math.floor(y / TILE_SIZE);
  const lx = x % TILE_SIZE;
  const ly = y % TILE_SIZE;
  const offset = ly * TILE_SIZE + lx;
  chunks[chunkIndex(ci, cj)][offset] = colorIdx;

  // Track stats
  if (users[cl.username]) {
    users[cl.username].totalPixels = (users[cl.username].totalPixels || 0) + 1;
  }

  // Broadcast to subscribed clients
  broadcastPixel(ci, cj, offset, colorIdx);
}

// ── BINARY PROTOCOL (chunk registration) ───────────────────
function handleBinary(ws, cl, buf) {
  if (buf.length === 0) return;
  const opcode = buf.readUInt8(0);

  switch (opcode) {
    case OP.REG_CANVAS: {
      // Client wants to register on a canvas
      // canvasId = buf[1] (we only have canvas 0)
      break;
    }
    case OP.REG_CHUNK: {
      // Register chunk to receive live pixel updates
      const chunkId = (buf[1] << 8) | buf[2];
      cl.registeredChunks.add(chunkId);
      // Send chunk data back
      const ci = (chunkId >> 8) & 0xFF;
      const cj = chunkId & 0xFF;
      if (ci < TILES && cj < TILES) {
        const chunkData = chunks[chunkIndex(ci, cj)];
        sendChunk(ws, ci, cj, chunkData);
      }
      break;
    }
    case OP.DEREG_CHUNK: {
      const chunkId = (buf[1] << 8) | buf[2];
      cl.registeredChunks.delete(chunkId);
      break;
    }
    default: break;
  }
}

// Send chunk: JSON header + raw Uint8Array payload
function sendChunk(ws, ci, cj, data) {
  if (ws.readyState !== WebSocket.OPEN) return;
  // Send as JSON with base64 payload for simplicity
  const msg = {
    type: 'chunk',
    ci, cj,
    data: Buffer.from(data).toString('base64'),
  };
  ws.send(JSON.stringify(msg));
}

// ── STACK REGEN ────────────────────────────────────────────
function regenStack(cl) {
  const now = Date.now();
  const toAdd = Math.floor((now - cl.lastRegen) / REGEN_MS);
  if (toAdd > 0 && cl.stack < MAX_STACK) {
    cl.stack = Math.min(MAX_STACK, cl.stack + toAdd);
    cl.lastRegen = now - ((now - cl.lastRegen) % REGEN_MS);
  }
}

// ── HTTP ROUTES ─────────────────────────────────────────────
app.use(express.static(__dirname));

// Canvas as raw RGBA PNG via /canvas.png
app.get('/canvas.png', (req, res) => {
  try {
    const sharp = require('sharp');
    // Build RGBA buffer from chunks
    const rgba = Buffer.allocUnsafe(CANVAS_SIZE * CANVAS_SIZE * 4);
    for (let py = 0; py < CANVAS_SIZE; py++) {
      for (let px = 0; px < CANVAS_SIZE; px++) {
        const ci = Math.floor(px / TILE_SIZE);
        const cj = Math.floor(py / TILE_SIZE);
        const offset = (py % TILE_SIZE) * TILE_SIZE + (px % TILE_SIZE);
        const colorIdx = chunks[chunkIndex(ci, cj)][offset];
        const [r, g, b] = PALETTE[colorIdx] || [0,0,0];
        const i = (py * CANVAS_SIZE + px) * 4;
        rgba[i] = r; rgba[i+1] = g; rgba[i+2] = b; rgba[i+3] = 255;
      }
    }
    sharp(rgba, { raw: { width: CANVAS_SIZE, height: CANVAS_SIZE, channels: 4 } })
      .png({ compressionLevel: 6 })
      .toBuffer()
      .then(buf => { res.setHeader('Content-Type','image/png'); res.send(buf); })
      .catch(() => res.status(500).end());
  } catch(e) { res.status(500).end(); }
});

// Chunk endpoint: /chunk/ci/cj → base64 of Uint8Array
app.get('/chunk/:ci/:cj', (req, res) => {
  const ci = parseInt(req.params.ci);
  const cj = parseInt(req.params.cj);
  if (isNaN(ci)||isNaN(cj)||ci<0||cj<0||ci>=TILES||cj>=TILES) return res.status(404).end();
  res.setHeader('Content-Type','application/octet-stream');
  res.setHeader('Cache-Control','no-cache');
  res.send(Buffer.from(chunks[chunkIndex(ci, cj)]));
});

// Canvas info
app.get('/api/canvas', (req, res) => {
  res.json({
    id: CANVAS_ID,
    size: CANVAS_SIZE,
    tileSize: TILE_SIZE,
    tiles: TILES,
    maxStack: MAX_STACK,
    regenMs: REGEN_MS,
    palette: PALETTE,
  });
});

// ── ONLINE COUNTER BROADCAST ───────────────────────────────
setInterval(broadcastOnline, 10000);

// ── START ──────────────────────────────────────────────────
loadUsers();
loadEarth();

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║          OkakPix v2.0                ║
║  http://localhost:${PORT}              ║
║  Admin: admin / admin (∞ stack)      ║
║  Canvas: ${CANVAS_SIZE}×${CANVAS_SIZE}, ${TILES}×${TILES} chunks      ║
╚══════════════════════════════════════╝
  `);
});
