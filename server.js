/**
 * OkakPix — Pixel Battle Multiplayer Server
 * + Chat, Leaderboard, Bot
 */

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const fs      = require('fs');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT     = process.env.PORT || 3000;
const CANVAS_W = 1000;
const CANVAS_H = 1000;
const MAX_STACK = 120;
const REGEN_INTERVAL_MS = 1000;

// ── CANVAS STATE ────────────────────────────────────────────
let canvasBuffer = Buffer.alloc(CANVAS_W * CANVAS_H * 4, 0);

function loadEarth() {
  const earthPath = path.join(__dirname, 'earth.png');
  if (!fs.existsSync(earthPath)) { console.log('[OkakPix] earth.png не знайдено'); return; }
  try {
    const sharp = require('sharp');
    sharp(earthPath)
      .resize(CANVAS_W, CANVAS_H, { fit: 'fill' })
      .raw().toBuffer({ resolveWithObject: true })
      .then(({ data, info }) => {
        for (let i = 0; i < CANVAS_W * CANVAS_H; i++) {
          const si=i*info.channels, di=i*4;
          canvasBuffer[di]=data[si]; canvasBuffer[di+1]=data[si+1];
          canvasBuffer[di+2]=data[si+2]; canvasBuffer[di+3]=255;
        }
        console.log(`[OkakPix] earth.png завантажено (${info.width}x${info.height})`);
      }).catch(e => console.error('[OkakPix] sharp error:', e.message));
  } catch(e) { console.log('[OkakPix] sharp недоступний'); }
}

function saveCanvas() {
  try { fs.writeFileSync(path.join(__dirname,'canvas_state.bin'), canvasBuffer); } catch(e) {}
}
function loadCanvasState() {
  const p = path.join(__dirname,'canvas_state.bin');
  if (fs.existsSync(p)) {
    const buf = fs.readFileSync(p);
    if (buf.length === canvasBuffer.length) { buf.copy(canvasBuffer); console.log('[OkakPix] canvas_state.bin відновлено'); return true; }
  }
  return false;
}

// ── USERS & LEADERBOARD ─────────────────────────────────────
const users    = new Map();
const pixelCount = new Map(); // username → total pixels placed

const USERS_FILE = path.join(__dirname, 'users.json');
function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      for (const [k,v] of Object.entries(data)) {
        users.set(k, v);
        if (v.totalPixels) pixelCount.set(k, v.totalPixels);
      }
    } catch(e) {}
  }
  if (!users.has('admin')) users.set('admin', { password:'admin', noCooldown:true, totalPixels:0 });
}
function saveUsers() {
  const obj = {};
  for (const [k,v] of users) obj[k] = { ...v, totalPixels: pixelCount.get(k) || 0 };
  fs.writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2));
}

function getLeaderboard() {
  const entries = [];
  for (const [username] of users) {
    entries.push({ username, pixels: pixelCount.get(username) || 0 });
  }
  return entries.sort((a,b) => b.pixels - a.pixels).slice(0, 20);
}

// ── WS CLIENTS ──────────────────────────────────────────────
const clients = new Map();

function broadcast(msg, except) {
  const str = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(str);
  }
}
function broadcastAll(msg) {
  const str = JSON.stringify(msg);
  for (const [ws] of clients) if (ws.readyState === WebSocket.OPEN) ws.send(str);
}
function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function getOnlineCount() { return clients.size; }

// ── CHAT HISTORY ─────────────────────────────────────────────
const chatHistory = []; // last 50 messages

function addChatMsg(username, text, isBot=false) {
  const msg = { username, text, isBot, ts: Date.now() };
  chatHistory.push(msg);
  if (chatHistory.length > 50) chatHistory.shift();
  return msg;
}

// ── BOT ──────────────────────────────────────────────────────
const BOT_NAME = '🤖 OkakBot';
const BOT_FACTS = [
  'Знаєте? Перша піксель-арт гра з\'явилась у 2017 році на Reddit — r/Place!',
  'На цьому полотні вже намальовано стільки всього цікавого 🎨',
  'Порада: використовуй олівець щоб малювати лінії!',
  'Ти можеш зберегти знімок полотна кнопкою 💾',
  'Разом ми можемо намалювати шедевр! 🖼️',
  'Admin має необмежений стак пікселів 👑',
  'Стак відновлюється з +1 піксель/секунду ⏱️',
  'Натисни 2 для режиму олівця, 1 для режиму пікселя!',
  'Використовуй колесо миші для зуму 🔍',
  'Мінімальний нікнейм — 3 символи, пароль — 4 символи',
];

const BOT_RESPONSES = {
  'привіт': ['Привіт! 👋 Гарного малювання!', 'Привіт! Радий тебе бачити 🎨', 'Привіт! Починай малювати!'],
  'hello':  ['Hello! 👋 Welcome to OkakPix!', 'Hi there! 🎨'],
  'hi':     ['Hi! 👋', 'Hello! Welcome!'],
  'допомога': ['Малюй пікселі кліком, використовуй олівець для ліній. Стак +1/сек 🎨', 'Обери колір в палітрі знизу і клікай по полотну!'],
  'help':   ['Click to place pixels, use pencil for lines. Stack regens +1/sec!'],
  'бот':    ['Я тут! 🤖 Чим можу допомогти?'],
  'bot':    ['I\'m here! 🤖 How can I help?'],
  'молодець': ['Дякую! 😊', 'Ти теж молодець! 🌟'],
  'красиво': ['Так! Дуже красиво 😍', 'Погоджуюсь! Чудова робота 🎨'],
  'стак':   ['Стак відновлюється +1 піксель/секунду. Максимум 120!'],
  'admin':  ['Адмін має безкінечний стак і 0 кулдауну 👑'],
  'лідер':  ['Подивись на лідерборд! Хто найбільше намалював? 🏆'],
};

function getBotReply(text) {
  const lower = text.toLowerCase().trim();
  for (const [key, replies] of Object.entries(BOT_RESPONSES)) {
    if (lower.includes(key)) return replies[Math.floor(Math.random() * replies.length)];
  }
  return null;
}

let botFactInterval = null;
function startBotFacts() {
  botFactInterval = setInterval(() => {
    if (clients.size === 0) return;
    const fact = BOT_FACTS[Math.floor(Math.random() * BOT_FACTS.length)];
    const msg = addChatMsg(BOT_NAME, fact, true);
    broadcastAll({ type: 'chat', ...msg });
  }, 3 * 60 * 1000); // кожні 3 хвилини
}

// ── PIXEL LOGIC ─────────────────────────────────────────────
function setPixel(x, y, r, g, b) {
  if (x<0||y<0||x>=CANVAS_W||y>=CANVAS_H) return false;
  const idx=(y*CANVAS_W+x)*4;
  canvasBuffer[idx]=r; canvasBuffer[idx+1]=g; canvasBuffer[idx+2]=b; canvasBuffer[idx+3]=255;
  return true;
}

// ── HTTP ─────────────────────────────────────────────────────
app.use(express.static(__dirname));

app.get('/canvas.png', (req, res) => {
  try {
    const sharp = require('sharp');
    sharp(Buffer.from(canvasBuffer), { raw:{ width:CANVAS_W, height:CANVAS_H, channels:4 } })
      .png().toBuffer()
      .then(buf => { res.setHeader('Content-Type','image/png'); res.setHeader('Cache-Control','no-cache'); res.send(buf); })
      .catch(() => { res.setHeader('Content-Type','application/octet-stream'); res.send(canvasBuffer); });
  } catch(e) { res.setHeader('Content-Type','application/octet-stream'); res.send(canvasBuffer); }
});

app.get('/canvas.raw', (req, res) => {
  res.setHeader('Content-Type','application/octet-stream');
  res.setHeader('X-Canvas-Width', CANVAS_W);
  res.setHeader('X-Canvas-Height', CANVAS_H);
  res.setHeader('Cache-Control','no-cache');
  res.send(canvasBuffer);
});

app.get('/api/leaderboard', (req, res) => {
  res.json(getLeaderboard());
});

// ── WEBSOCKET ─────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const client = { username:null, stack:MAX_STACK, lastRegen:Date.now(), noCooldown:false, ip };
  clients.set(ws, client);

  sendTo(ws, { type:'init', width:CANVAS_W, height:CANVAS_H });
  broadcastAll({ type:'online', count:getOnlineCount() });

  // Send recent chat history
  if (chatHistory.length > 0) sendTo(ws, { type:'chat_history', messages: chatHistory.slice(-20) });

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    switch(msg.type) {

      case 'login': {
        const {username, password} = msg;
        if (!username||!password) { sendTo(ws,{type:'auth_fail',reason:'Заповніть всі поля'}); return; }
        const u = users.get(username);
        if (!u)              { sendTo(ws,{type:'auth_fail',reason:'Користувача не знайдено'}); return; }
        if (u.password!==password) { sendTo(ws,{type:'auth_fail',reason:'Невірний пароль'}); return; }
        client.username=username; client.noCooldown=!!u.noCooldown;
        client.stack=client.noCooldown?999999:MAX_STACK;
        sendTo(ws,{type:'auth_ok',username,noCooldown:client.noCooldown,stack:client.stack,totalPixels:pixelCount.get(username)||0});
        broadcastAll({type:'online',count:getOnlineCount()});
        // Bot welcome
        setTimeout(() => {
          const welcomes = [`Ласкаво просимо, ${username}! 🎉`, `${username} приєднався! Привіт! 👋`, `О, ${username} вже тут! Гарного малювання 🎨`];
          const txt = welcomes[Math.floor(Math.random()*welcomes.length)];
          const chatMsg = addChatMsg(BOT_NAME, txt, true);
          broadcastAll({type:'chat',...chatMsg});
        }, 800);
        break;
      }

      case 'register': {
        const {username, password} = msg;
        if (!username||!password) { sendTo(ws,{type:'auth_fail',reason:'Заповніть всі поля'}); return; }
        if (username.length<3)    { sendTo(ws,{type:'auth_fail',reason:'Нікнейм мінімум 3 символи'}); return; }
        if (password.length<4)    { sendTo(ws,{type:'auth_fail',reason:'Пароль мінімум 4 символи'}); return; }
        if (users.has(username))  { sendTo(ws,{type:'auth_fail',reason:'Нікнейм вже зайнятий'}); return; }
        users.set(username,{password,noCooldown:false,totalPixels:0});
        pixelCount.set(username, 0);
        saveUsers();
        client.username=username; client.noCooldown=false; client.stack=MAX_STACK;
        sendTo(ws,{type:'auth_ok',username,noCooldown:false,stack:MAX_STACK,totalPixels:0});
        broadcastAll({type:'online',count:getOnlineCount()});
        setTimeout(() => {
          const txt = `Новий гравець ${username} зареєструвався! Вітаємо! 🆕🎉`;
          const chatMsg = addChatMsg(BOT_NAME, txt, true);
          broadcastAll({type:'chat',...chatMsg});
        }, 600);
        break;
      }

      case 'pixel': {
        if (!client.username) { sendTo(ws,{type:'error',reason:'Потрібна авторизація'}); return; }
        if (!client.noCooldown) {
          const now=Date.now(), toAdd=Math.floor((now-client.lastRegen)/REGEN_INTERVAL_MS);
          if(toAdd>0){client.stack=Math.min(MAX_STACK,client.stack+toAdd);client.lastRegen=now-((now-client.lastRegen)%REGEN_INTERVAL_MS);}
          if(client.stack<=0){sendTo(ws,{type:'stack_empty'});return;}
          client.stack--;
        }
        const {x,y,color} = msg;
        const r=parseInt(color.slice(1,3),16), g=parseInt(color.slice(3,5),16), b=parseInt(color.slice(5,7),16);
        if(!setPixel(x,y,r,g,b)) return;
        // Track pixels
        pixelCount.set(client.username, (pixelCount.get(client.username)||0)+1);
        broadcastAll({type:'pixel',x,y,color,by:client.username});
        if(!client.noCooldown) sendTo(ws,{type:'stack_update',stack:client.stack});
        // Broadcast leaderboard update every 10 pixels
        const total = pixelCount.get(client.username);
        if(total % 10 === 0) broadcastAll({type:'leaderboard',data:getLeaderboard()});
        break;
      }

      case 'chat': {
        if (!client.username) { sendTo(ws,{type:'error',reason:'Потрібна авторизація'}); return; }
        let text = String(msg.text||'').trim().slice(0,200);
        if (!text) return;
        const chatMsg = addChatMsg(client.username, text, false);
        broadcastAll({type:'chat',...chatMsg});
        // Bot reply
        const reply = getBotReply(text);
        if (reply) {
          setTimeout(() => {
            const botMsg = addChatMsg(BOT_NAME, reply, true);
            broadcastAll({type:'chat',...botMsg});
          }, 600 + Math.random()*800);
        }
        break;
      }

      case 'request_canvas': {
        const CHUNK=50000, total=CANVAS_W*CANVAS_H;
        let offset=0, chunkIdx=0;
        const totalChunks=Math.ceil(total/CHUNK);
        function sendChunk(){
          if(offset>=total) return;
          const end=Math.min(offset+CHUNK,total);
          const slice=canvasBuffer.slice(offset*4,end*4);
          sendTo(ws,{type:'canvas_chunk',offset,data:slice.toString('base64'),chunkIdx,totalChunks,width:CANVAS_W,height:CANVAS_H});
          offset=end; chunkIdx++;
          setImmediate(sendChunk);
        }
        sendChunk(); break;
      }

      case 'request_leaderboard':
        sendTo(ws,{type:'leaderboard',data:getLeaderboard()}); break;
    }
  });

  ws.on('close', () => { clients.delete(ws); broadcastAll({type:'online',count:getOnlineCount()}); });
  ws.on('error', () => clients.delete(ws));
});

setInterval(saveCanvas, 30000);
setInterval(saveUsers, 60000);

loadUsers();
if (!loadCanvasState()) loadEarth();
startBotFacts();

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║        OkakPix Pixel Battle          ║
║  http://localhost:${PORT}              ║
║  Admin: admin / admin                ║
╚══════════════════════════════════════╝
  `);
});

