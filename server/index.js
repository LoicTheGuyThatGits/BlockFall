/**
 * Blockfall server: static file host + authoritative game server.
 *
 * One process does both jobs, which keeps deployment to a single container.
 * Set PORT to change the listen port (most PaaS providers inject it).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { RoomRegistry, COLORS, sanitizeName } from './rooms.js';
import { MSG } from '../src/core/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SRC_DIR = path.join(ROOT, 'src');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const registry = new RoomRegistry();

// ------------------------------------------------------------ http server

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      rooms: registry.rooms.size,
      uptime: Math.round(process.uptime()),
    });
  }

  if (url.pathname === '/api/rooms') {
    return sendJson(res, 200, { rooms: registry.list() });
  }

  // Serve static files. /src is exposed so the browser can import the shared
  // engine module instead of shipping a duplicate copy.
  let filePath = resolveStatic(url.pathname);
  if (!filePath) {
    return sendText(res, 404, 'Not found');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Single page app fallback.
      const index = path.join(PUBLIC_DIR, 'index.html');
      return fs.readFile(index, (e2, buf) => {
        if (e2) return sendText(res, 404, 'Not found');
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(buf);
      });
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // No caching in dev so edits show up on reload; long cache for assets.
    headers['Cache-Control'] = url.pathname.startsWith('/src/')
      ? 'no-cache'
      : ext === '.html'
        ? 'no-cache'
        : 'public, max-age=3600';
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
});

/** Map a URL path to a file inside PUBLIC_DIR or SRC_DIR, blocking traversal. */
function resolveStatic(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  if (clean.includes('\0')) return null;
  // Map /src/... to the shared engine folder, everything else to public/.
  const fromSrc = clean.startsWith('/src/');
  const base = fromSrc ? SRC_DIR : PUBLIC_DIR;
  const sub = fromSrc ? clean.slice(4) : clean === '/' ? '/index.html' : clean;

  // `./${sub}` keeps the leading slash so resolve cannot climb out of base.
  const target = path.resolve(base, `.${sub.startsWith('/') ? sub : `/${sub}`}`);
  const root = path.resolve(base);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// ----------------------------------------------------------- websockets

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.ctx = { room: null, playerId: null, spectatorId: null, name: null };

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error('handler error', err);
      send(ws, { t: MSG.ERROR, message: 'Something went wrong' });
    }
  });

  ws.on('close', () => cleanup(ws));

  ws.on('error', () => cleanup(ws));

  send(ws, {
    t: MSG.HELLO,
    id: null,
    colors: COLORS,
    online: wss.clients.size,
  });
});

function handleMessage(ws, msg) {
  switch (msg.t) {
    case MSG.JOIN: {
      // Leave any previous room first.
      cleanup(ws);
      const name = sanitizeName(msg.name);
      let room;
      if (msg.code) {
        room = registry.get(msg.code);
        if (!room) {
          return send(ws, { t: MSG.ERROR, message: `No room called ${msg.code}` });
        }
        // Private rooms are still joinable by code, which is the whole point.
        const full = room.players.size >= room.settings.maxPlayers;
        if (full && !(msg.asSpectator && room.settings.allowSpectators)) {
          return send(ws, { t: MSG.ERROR, message: 'That room is full' });
        }
      } else {
        room = registry.create(ws, { settings: msg.settings });
      }

      ws.ctx.name = name;
      ws.ctx.room = room;

      if (msg.asSpectator && room.settings.allowSpectators) {
        const s = room.spectate(ws);
        ws.ctx.spectatorId = s.id;
      } else {
        const p = room.join(ws, { name, color: msg.color });
        ws.ctx.playerId = p.id;
      }

      send(ws, {
        t: MSG.HELLO,
        playerId: ws.ctx.playerId,
        spectatorId: ws.ctx.spectatorId,
      });
      room.broadcastState();
      return;
    }

    case MSG.QUICK_PLAY: {
      cleanup(ws);
      const mode = ['marathon', 'sprint', 'versus'].includes(msg.mode) ? msg.mode : 'marathon';
      let room = registry.findQuickPlay(mode);
      if (!room || room.players.size >= room.settings.maxPlayers) {
        room = registry.create(ws, { settings: { mode } });
      }
      return joinRoom(ws, room, msg);
    }

    case MSG.LIST_ROOMS:
      return send(ws, { t: MSG.ROOM_LIST, rooms: registry.list() });

    case MSG.LEAVE:
      cleanup(ws);
      send(ws, { t: MSG.LEFT });
      return;

    case MSG.SET_READY: {
      const { room, playerId } = ws.ctx;
      if (!room || !playerId) return;
      room.setReady(playerId, msg.ready);
      room.broadcastState();
      return;
    }

    case MSG.SET_SETTINGS: {
      const { room, playerId } = ws.ctx;
      if (!room || !playerId) return;
      if (room.setSettings(playerId, msg.settings || {})) room.broadcastState();
      return;
    }

    case MSG.START: {
      const { room, playerId } = ws.ctx;
      if (!room || !playerId) return;
      const err = room.start();
      if (err) send(ws, { t: MSG.ERROR, message: err });
      return;
    }

    case MSG.INPUT: {
      const { room, playerId } = ws.ctx;
      if (!room || !playerId) return;
      if (Array.isArray(msg.inputs)) {
        for (const i of msg.inputs.slice(0, 16)) room.queueInput(playerId, sanitizeInput(i));
      } else {
        room.queueInput(playerId, sanitizeInput(msg.input));
      }
      return;
    }

    case MSG.CHAT: {
      const { room } = ws.ctx;
      if (!room) return;
      room.chat(ws, msg.text);
      return;
    }

    case MSG.REMATCH: {
      const { room, playerId } = ws.ctx;
      if (!room || !playerId) return;
      room.requestRematch(playerId);
      room.broadcastState();
      return;
    }

    case MSG.PING:
      return send(ws, { t: MSG.PONG, c: msg.c, serverTime: Date.now() });

    default:
      return;
  }
}

function joinRoom(ws, room, msg) {
  ws.ctx.room = room;
  ws.ctx.name = sanitizeName(msg.name);
  const p = room.join(ws, { name: ws.ctx.name, color: msg.color });
  ws.ctx.playerId = p.id;
  send(ws, { t: MSG.HELLO, playerId: p.id });
  room.broadcastState();
}

function cleanup(ws) {
  const { room, playerId, spectatorId } = ws.ctx || {};
  if (!room) return;
  if (playerId) room.leave(playerId);
  if (spectatorId) room.unspectate(spectatorId);
  ws.ctx.room = null;
  ws.ctx.playerId = null;
  ws.ctx.spectatorId = null;
  room.broadcastState();
}

/** Whitelist input fields so nothing unexpected reaches the simulation. */
function sanitizeInput(i) {
  const out = {};
  if (typeof i?.dx === 'number' && (i.dx === -1 || i.dx === 1)) out.dx = i.dx;
  if (typeof i?.rot === 'number' && [-1, 1, 2].includes(i.rot)) out.rot = i.rot;
  if (typeof i?.softDrop === 'boolean') out.softDrop = i.softDrop;
  if (i?.hardDrop === true) out.hardDrop = true;
  if (i?.hold === true) out.hold = true;
  return out;
}

function send(ws, obj) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------ game loop

setInterval(() => {
  const now = Date.now();
  for (const room of registry.rooms.values()) room.update(now);
}, 1000 / 60);

setInterval(() => {
  registry.sweep();
}, 15_000);

// Drop sockets that stopped answering.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      cleanup(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30_000);

server.listen(PORT, HOST, () => {
  console.log(`Blockfall listening on http://${HOST}:${PORT}`);
  console.log(`WebSocket endpoint: ws://${HOST}:${PORT}/ws`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} received, closing.`);
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}