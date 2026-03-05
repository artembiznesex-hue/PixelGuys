/**
 * OkakPix — Pixel Battle Server
 * Протокол: /api/canvas, /chunk/ci/cj, /ws (бінарний + JSON)
 * + Чат, Лідерборд, Бот
 */
'use strict';
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });

const PORT        = process.env.PORT || 3000;
const CANVAS_SIZE = 1000;
const TILE_SIZE   = 100;
const TILES       = CANVAS_SIZE / TILE_SIZE; // 10
const MAX_STACK   = 120;
const REGEN_MS    = 1000;

// ─── ПАЛІТРА ────────────────────────────────────────────────
// Індекс 0,1 — резерв; з 2 — кольори
const PALETTE = [
  [202,227,255],[202,227,255],
  [255,255,255],[228,228,228],[196,196,196],[136,136,136],[78,78,78],[0,0,0],
  [244,179,174],[255,167,209],[255,84,178],[255,101,101],[229,0,0],[154,0,0],
  [254,164,96],[229,149,0],[160,106,66],[96,64,40],[245,223,176],[255,248,137],
  [229,217,0],[148,224,68],[2,190,1],[104,131,56],[0,101,19],[202,227,255],
  [0,211,221],[0,131,199],[0,0,234],[25,25,115],[207,110,228],[130,0,128],
];

// ─── CANVAS (індекси палітри, 1 байт/піксель) ───────────────
let canvas = new Uint8Array(CANVAS_SIZE * CANVAS_SIZE); // все = 0

function px(x, y) { return y * CANVAS_SIZE + x; }

// Квантизація earth.png → палітра
async function loadEarth() {
  const p = path.join(__dirname, 'earth.png');
  if (!fs.existsSync(p)) { console.log('[OkakPix] earth.png не знайдено'); return; }
  try {
    const sharp = require('sharp');
    const { data, info } = await sharp(p)
      .resize(CANVAS_SIZE, CANVAS_SIZE, { fit: 'fill' })
      .raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < CANVAS_SIZE * CANVAS_SIZE; i++) {
      const si = i * info.channels, r = data[si], g = data[si+1], b = data[si+2];
      let best = 2, bestD = Infinity;
      for (let pi = 2; pi < PALETTE.length; pi++) {
        const [pr,pg,pb] = PALETTE[pi];
        const d = (r-pr)**2+(g-pg)**2+(b-pb)**2;
        if (d < bestD) { bestD = d; best = pi; }
      }
      canvas[i] = best;
    }
    console.log(`[OkakPix] earth.png завантажено і квантизовано`);
  } catch(e) { console.error('[OkakPix] earth помилка:', e.message); }
}

const CANVAS_FILE = path.join(__dirname, 'canvas_state.bin');
function saveCanvas() { try { fs.writeFileSync(CANVAS_FILE, Buffer.from(canvas)); } catch(e){} }
function loadCanvas() {
  if (!fs.existsSync(CANVAS_FILE)) return false;
  const buf = fs.readFileSync(CANVAS_FILE);
  if (buf.length !== canvas.length) return false;
  canvas.set(buf);
  console.log('[OkakPix] canvas_state.bin відновлено');
  return true;
}

// ─── ТАЙЛ ───────────────────────────────────────────────────
function getTile(ci, cj) {
  const out = new Uint8Array(TILE_SIZE * TILE_SIZE);
  for (let ty = 0; ty < TILE_SIZE; ty++)
    for (let tx = 0; tx < TILE_SIZE; tx++)
      out[ty * TILE_SIZE + tx] = canvas[px(ci*TILE_SIZE+tx, cj*TILE_SIZE+ty)];
  return out;
}

// ─── USERS ──────────────────────────────────────────────────
const users      = new Map(); // username → {password, noCooldown, totalPixels}
const pixelCount = new Map(); // username → count

const USERS_FILE = path.join(__dirname, 'users.json');
function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    try {
      for (const [k,v] of Object.entries(JSON.parse(fs.readFileSync(USERS_FILE,'utf8')))) {
        users.set(k, v);
        if (v.totalPixels) pixelCount.set(k, v.totalPixels);
      }
    } catch(e) {}
  }
  if (!users.has('admin')) users.set('admin', { password:'admin', noCooldown:true });
}
function saveUsers() {
  const obj = {};
  for (const [k,v] of users) obj[k] = { ...v, totalPixels: pixelCount.get(k)||0 };
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2)); } catch(e) {}
}

// ─── LEADERBOARD ────────────────────────────────────────────
function getLeaderboard() {
  return [...users.keys()]
    .map(u => ({ username:u, pixels:pixelCount.get(u)||0 }))
    .sort((a,b) => b.pixels-a.pixels).slice(0,20);
}

// ─── CHAT / BOT ─────────────────────────────────────────────
const chatHistory = [];
function pushChat(username, text, isBot=false) {
  const m = { username, text, isBot, ts: Date.now() };
  chatHistory.push(m);
  if (chatHistory.length > 100) chatHistory.shift();
  return m;
}

const BOT_NAME = '🤖 OkakBot';
const BOT_FACTS = [
  'Порада: 2 пальці — зум на телефоні! 📱',
  'Клавіша 2 — режим олівця ✏️',
  'Стак: +1 піксель/секунду ⏱️',
  'Однаковий колір не витрачає стак! 💡',
  'Адмін має нескінченний стак 👑',
  'Натисни 💾 для збереження полотна!',
  'r/place — натхнення цього проекту 🎨',
  'Кличте друзів! 👥',
];
const BOT_KEYS = {
  'привіт': ['Привіт! 👋','Привіт! Гарного малювання! 🎨'],
  'hello':  ['Hello! 👋 Welcome!'],
  'hi':     ['Hi there! 👋'],
  'бот':    ['Тут! 🤖 Чим можу?'],
  'допомога': ['ЛКМ — піксель, ПКМ/пробіл — рух, колесо — зум'],
  'help':   ['LMB — pixel, RMB/space — pan, wheel — zoom'],
  'стак':   ['Стак 120 пікселів, +1/сек. Адмін — ∞'],
  'лідер':  ['Лідерборд → кнопка 🏆'],
  'красиво':['Дуже! 😍'],
  'молодець':['Дякую! 😊','Ти теж! ⭐'],
};
function botReply(text) {
  const lo = text.toLowerCase();
  for (const [k,v] of Object.entries(BOT_KEYS))
    if (lo.includes(k)) return v[Math.floor(Math.random()*v.length)];
  return null;
}
function botSay(text) {
  const m = pushChat(BOT_NAME, text, true);
  broadcastJSON({ type:'chat', ...m });
}
setInterval(()=>{
  if (clients.size > 0) botSay(BOT_FACTS[Math.floor(Math.random()*BOT_FACTS.length)]);
}, 3*60*1000);

// ─── WS CLIENTS ─────────────────────────────────────────────
const clients = new Map(); // ws → client

function broadcastJSON(msg, except) {
  const s = JSON.stringify(msg);
  for (const [ws] of clients)
    if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(s);
}
function broadcastAll(msg) {
  const s = JSON.stringify(msg);
  for (const [ws] of clients) if (ws.readyState === WebSocket.OPEN) ws.send(s);
}
function sendJ(ws, msg) { if (ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

// Бінарний пакет пікселя: [0xC1, ci, cj, off_hi, off_lo_hi, off_lo_lo, colorIdx]
function broadcastPixel(ci, cj, offset, colorIdx) {
  const buf = Buffer.alloc(7);
  buf[0]=0xC1; buf[1]=ci; buf[2]=cj;
  buf[3]=(offset>>16)&0xFF;
  buf.writeUInt16BE(offset&0xFFFF, 4);
  buf[6]=colorIdx;
  for (const [ws] of clients) if (ws.readyState===WebSocket.OPEN) ws.send(buf);
}

// Бінарний пакет онлайн: [0xA7, count_hi, count_lo]
function broadcastOnline() {
  const buf = Buffer.alloc(3);
  buf[0]=0xA7;
  buf.writeInt16BE(clients.size, 1);
  for (const [ws] of clients) if (ws.readyState===WebSocket.OPEN) ws.send(buf);
}

// ─── HTTP ────────────────────────────────────────────────────
app.use(express.static(__dirname));

app.get('/api/canvas', (req, res) => res.json({
  size: CANVAS_SIZE, tileSize: TILE_SIZE, tiles: TILES,
  maxStack: MAX_STACK, regenMs: REGEN_MS, palette: PALETTE
}));

app.get('/chunk/:ci/:cj', (req, res) => {
  const ci=+req.params.ci, cj=+req.params.cj;
  if (ci<0||cj<0||ci>=TILES||cj>=TILES) return res.status(404).end();
  res.setHeader('Content-Type','application/octet-stream');
  res.setHeader('Cache-Control','no-cache');
  res.send(Buffer.from(getTile(ci, cj)));
});

app.get('/api/leaderboard', (req, res) => res.json(getLeaderboard()));

// ─── WEBSOCKET ───────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const client = { username:null, stack:MAX_STACK, lastRegen:Date.now(), noCooldown:false };
  clients.set(ws, client);
  ws.binaryType = 'arraybuffer';

  broadcastOnline();

  // Надіслати останні 20 повідомлень чату
  if (chatHistory.length)
    sendJ(ws, { type:'chat_history', messages: chatHistory.slice(-20) });

  ws.on('message', raw => {
    // ── Бінарні пакети від клієнта ──────────────────────────
    if (raw instanceof Buffer || raw instanceof ArrayBuffer) {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (buf[0] === 0xA1) {
        // Підписка на чанк — відповідаємо JSON chunk
        const ci=buf[1], cj=buf[2];
        if (ci>=0&&cj>=0&&ci<TILES&&cj<TILES)
          sendJ(ws, { type:'chunk', ci, cj, data: Buffer.from(getTile(ci,cj)).toString('base64') });
      }
      return;
    }

    // ── JSON пакети ─────────────────────────────────────────
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'login': {
        const {username,password}=msg;
        if (!username||!password) { sendJ(ws,{type:'auth_fail',reason:'Заповніть всі поля'}); return; }
        const u = users.get(username);
        if (!u)                  { sendJ(ws,{type:'auth_fail',reason:'Користувача не знайдено'}); return; }
        if (u.password!==password){ sendJ(ws,{type:'auth_fail',reason:'Невірний пароль'}); return; }
        client.username=username; client.noCooldown=!!u.noCooldown;
        client.stack=client.noCooldown?999999:MAX_STACK;
        sendJ(ws,{type:'auth_ok',username,noCooldown:client.noCooldown,stack:client.stack});
        broadcastOnline();
        setTimeout(()=>botSay([`Ласкаво просимо, ${username}! 🎉`,`${username} повернувся! 👋`,`О, ${username}! Гарного малювання 🎨`][Math.floor(Math.random()*3)]),700);
        break;
      }

      case 'register': {
        const {username,password}=msg;
        if (!username||!password){ sendJ(ws,{type:'auth_fail',reason:'Заповніть всі поля'}); return; }
        if (username.length<3)   { sendJ(ws,{type:'auth_fail',reason:'Нікнейм мінімум 3 символи'}); return; }
        if (password.length<4)   { sendJ(ws,{type:'auth_fail',reason:'Пароль мінімум 4 символи'}); return; }
        if (users.has(username)) { sendJ(ws,{type:'auth_fail',reason:'Нікнейм вже зайнятий'}); return; }
        users.set(username,{password,noCooldown:false}); pixelCount.set(username,0);
        saveUsers();
        client.username=username; client.noCooldown=false; client.stack=MAX_STACK;
        sendJ(ws,{type:'auth_ok',username,noCooldown:false,stack:MAX_STACK});
        broadcastOnline();
        setTimeout(()=>botSay(`Новий гравець ${username} зареєструвався! 🆕🎉`),600);
        break;
      }

      case 'pixel': {
        if (!client.username){ sendJ(ws,{type:'error',reason:'Авторизуйтесь'}); return; }

        // Відновлення стаку
        if (!client.noCooldown) {
          const now=Date.now(), add=Math.floor((now-client.lastRegen)/REGEN_MS);
          if (add>0){ client.stack=Math.min(MAX_STACK,client.stack+add); client.lastRegen=now-((now-client.lastRegen)%REGEN_MS); }
          if (client.stack<=0){ sendJ(ws,{type:'stack_empty'}); return; }
        }

        const {x,y,colorIdx,brushSize=1}=msg;
        const half=Math.floor(brushSize/2);
        let placed=0;
        for (let dy=-half; dy<brushSize-half; dy++) {
          for (let dx=-half; dx<brushSize-half; dx++) {
            const px_=x+dx, py_=y+dy;
            if (px_<0||py_<0||px_>=CANVAS_SIZE||py_>=CANVAS_SIZE) continue;
            const ci=Math.floor(px_/TILE_SIZE), cj=Math.floor(py_/TILE_SIZE);
            const offset=(py_%TILE_SIZE)*TILE_SIZE+(px_%TILE_SIZE);
            const old=canvas[py_*CANVAS_SIZE+px_];
            if (old===colorIdx) continue; // той самий колір — не витрачаємо стак
            canvas[py_*CANVAS_SIZE+px_]=colorIdx;
            broadcastPixel(ci,cj,offset,colorIdx);
            placed++;
          }
        }
        if (!client.noCooldown && placed>0) {
          client.stack=Math.max(0,client.stack-placed);
          sendJ(ws,{type:'stack_update',stack:client.stack});
        }
        if (placed>0) {
          const cnt=(pixelCount.get(client.username)||0)+placed;
          pixelCount.set(client.username,cnt);
          if (cnt%20===0) broadcastAll({type:'leaderboard',data:getLeaderboard()});
        }
        break;
      }

      case 'chat': {
        if (!client.username) return;
        const text=String(msg.text||'').trim().slice(0,200);
        if (!text) return;
        const m=pushChat(client.username,text,false);
        broadcastAll({type:'chat',...m});
        const reply=botReply(text);
        if (reply) setTimeout(()=>botSay(reply),500+Math.random()*700);
        break;
      }

      case 'request_leaderboard':
        sendJ(ws,{type:'leaderboard',data:getLeaderboard()}); break;
    }
  });

  ws.on('close', ()=>{ clients.delete(ws); broadcastOnline(); });
  ws.on('error', ()=>  clients.delete(ws));
});

// ─── CТАРТ ──────────────────────────────────────────────────
setInterval(saveCanvas, 30000);
setInterval(saveUsers,  60000);

loadUsers();
if (!loadCanvas()) loadEarth().catch(console.error);

server.listen(PORT, ()=>{
  console.log(`
╔══════════════════════════════════════╗
║        OkakPix Pixel Battle          ║
║  http://localhost:${PORT}              ║
║  Admin: admin / admin                ║
╚══════════════════════════════════════╝`);
});
