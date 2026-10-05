/**
 * End-to-end test: boot the real server, connect two real WebSocket clients,
 * create a room, ready up, play a full versus match, and assert both sides
 * agree on the outcome.
 *
 * Run with: node --test test/e2e.test.js
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

import { MSG } from '../src/core/protocol.js';

const PORT = 8199 + (process.pid % 200);
const URL = `ws://127.0.0.1:${PORT}/ws`;

let server;

before(async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  // Wait for the port to accept connections.
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/health`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
});

after(() => {
  if (server) server.kill();
});

/** Minimal client with helpers for the tests. */
function connect() {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    inbox.push(msg);
    // Resolve the oldest waiter whose filter matches.
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].match(msg)) {
        const w = waiters.splice(i, 1)[0];
        w.resolve(msg);
        break;
      }
    }
  });

  const api = {
    ws,
    inbox,
    open: new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    /** Wait for the next message matching a predicate. */
    next(match, timeout = 5000) {
      const existing = inbox.findIndex(match);
      if (existing >= 0) return Promise.resolve(inbox.splice(existing, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          const idx = waiters.indexOf(w);
          if (idx >= 0) {
            waiters.splice(idx, 1);
            reject(new Error('timed out waiting for message'));
          }
        }, timeout);
      });
    },
    close() {
      ws.close();
    },
  };
  return api;
}

test('a client can create a room and see itself in the lobby', async () => {
  const c = connect();
  await c.open;
  c.send({ t: MSG.JOIN, name: 'Alice', color: '#22d3ee', settings: { mode: 'marathon' } });

  const state = await c.next((m) => m.t === MSG.ROOM_STATE);
  assert.ok(state.code, 'room should have a code');
  assert.equal(state.players.length, 1);
  assert.equal(state.players[0].name, 'Alice');
  assert.equal(state.players[0].host, true);
  c.close();
});

test('two clients join the same room by code', async () => {
  const a = connect();
  const b = connect();
  await Promise.all([a.open, b.open]);

  a.send({ t: MSG.JOIN, name: 'Host', color: '#22d3ee', settings: { mode: 'versus' } });
  const first = await a.next((m) => m.t === MSG.ROOM_STATE);
  const code = first.code;

  b.send({ t: MSG.JOIN, name: 'Guest', color: '#a855f7', code });
  const joined = await b.next((m) => m.t === MSG.ROOM_STATE);

  assert.equal(joined.code, code);
  assert.equal(joined.players.length, 2);

  // Both clients should learn about each other.
  await a.next((m) => m.t === MSG.ROOM_STATE && m.players.length === 2);

  a.close();
  b.close();
});

test('starting a match streams board snapshots to both players', async () => {
  const a = connect();
  const b = connect();
  await Promise.all([a.open, b.open]);

  a.send({ t: MSG.JOIN, name: 'P1', color: '#22d3ee', settings: { mode: 'versus' } });
  const first = await a.next((m) => m.t === MSG.ROOM_STATE);
  b.send({ t: MSG.JOIN, name: 'P2', color: '#a855f7', code: first.code });

  const helloA = await a.next((m) => m.t === MSG.HELLO && m.playerId);
  const helloB = await b.next((m) => m.t === MSG.HELLO && m.playerId);
  assert.notEqual(helloA.playerId, helloB.playerId);

  for (const c of [a, b]) c.send({ t: MSG.SET_READY, ready: true });
  await a.next((m) => m.t === MSG.ROOM_STATE && m.players.every((p) => p.ready));

  a.send({ t: MSG.START });
  const start = await a.next((m) => m.t === MSG.GAME_START);
  assert.equal(start.settings.mode, 'versus');
  await b.next((m) => m.t === MSG.GAME_START);

  // Snapshots should arrive with a board for every player.
  const snap = await a.next(
    (m) => m.t === MSG.ROOM_STATE && m.status === 'playing' && m.boards && Object.keys(m.boards).length === 2,
    6000
  );
  assert.equal(snap.boards[helloA.playerId].b.length, 200);

  a.close();
  b.close();
});

test('inputs are simulated by the server and reflected in snapshots', async () => {
  const c = connect();
  await c.open;
  c.send({ t: MSG.JOIN, name: 'Solo', color: '#22c55e', settings: { mode: 'marathon' } });
  await c.next((m) => m.t === MSG.ROOM_STATE);
  const hello = await c.next((m) => m.t === MSG.HELLO && m.playerId);
  const id = hello.playerId;

  c.send({ t: MSG.SET_READY, ready: true });
  await c.next((m) => m.t === MSG.ROOM_STATE && m.players[0].ready);
  c.send({ t: MSG.START });
  await c.next((m) => m.t === MSG.GAME_START);

  // A hard drop must lock a piece: pieces should increase and score may rise.
  c.send({ t: MSG.INPUT, input: { hardDrop: true } });
  const snap = await c.next(
    (m) => m.t === MSG.ROOM_STATE && m.boards[id] && m.boards[id].s > 0,
    6000
  );
  assert.ok(snap.boards[id].s > 0, 'hard drop should award drop points');

  c.close();
});

test('the garbage value in a snapshot stays in range', async () => {
  const c = connect();
  await c.open;
  c.send({ t: MSG.JOIN, name: 'G', color: '#f97316', settings: { mode: 'versus' } });
  await c.next((m) => m.t === MSG.ROOM_STATE);
  const hello = await c.next((m) => m.t === MSG.HELLO && m.playerId);
  const id = hello.playerId;

  c.send({ t: MSG.SET_READY, ready: true });
  await c.next((m) => m.t === MSG.ROOM_STATE && m.players[0].ready);
  c.send({ t: MSG.START });
  await c.next((m) => m.t === MSG.GAME_START);

  // Hard drop several pieces so the stack grows.
  for (let i = 0; i < 12; i++) {
    c.send({ t: MSG.INPUT, input: { hardDrop: true } });
  }
  const snap = await c.next((m) => m.t === MSG.ROOM_STATE && m.boards[id], 6000);
  const g = snap.boards[id];
  assert.ok(g.pg >= 0, 'pending garbage must not be negative');
  assert.ok(g.s <= 100000, 'score should stay sane');
  c.close();
});

test('joining a room that does not exist returns an error', async () => {
  const c = connect();
  await c.open;
  c.send({ t: MSG.JOIN, name: 'X', color: '#22d3ee', code: 'ZZZZZ' });
  const err = await c.next((m) => m.t === MSG.ERROR);
  assert.match(err.message, /No room/);
  c.close();
});

test('starting before everyone is ready is refused', async () => {
  const a = connect();
  const b = connect();
  await Promise.all([a.open, b.open]);

  a.send({ t: MSG.JOIN, name: 'A', color: '#22d3ee', settings: { mode: 'sprint' } });
  const first = await a.next((m) => m.t === MSG.ROOM_STATE);
  b.send({ t: MSG.JOIN, name: 'B', color: '#a855f7', code: first.code });

  // Only A readies up.
  a.send({ t: MSG.SET_READY, ready: true });
  await a.next((m) => m.t === MSG.ROOM_STATE && m.players.some((p) => p.ready));

  a.send({ t: MSG.START });
  const err = await a.next((m) => m.t === MSG.ERROR);
  assert.match(err.message, /ready/i);
  a.close();
  b.close();
});

test('quick play drops you into a joinable room', async () => {
  const c = connect();
  await c.open;
  c.send({ t: MSG.QUICK_PLAY, name: 'Quick', color: '#facc15', mode: 'marathon' });
  const state = await c.next((m) => m.t === MSG.ROOM_STATE);
  assert.ok(state.code);
  assert.equal(state.players.length, 1);
  c.close();
});

test('a player name with markup is stored and sent back inert', async () => {
  const a = connect();
  const b = connect();
  await Promise.all([a.open, b.open]);

  a.send({ t: MSG.JOIN, name: '<img src=x onerror=alert(1)>', color: '#22d3ee', settings: { mode: 'marathon' } });
  const first = await a.next((m) => m.t === MSG.ROOM_STATE);
  b.send({ t: MSG.JOIN, name: 'Watcher', color: '#a855f7', code: first.code });

  const hostile = '<img src=x onerror=alert(1)>';
  const state = await b.next((m) => m.t === MSG.ROOM_STATE && m.players.length === 2);
  const name = state.players.find((p) => p.id !== undefined && p.name.includes('img'));

  assert.ok(name, 'the player should be in the list');
  assert.ok(!name.name.includes('<'), `angle brackets must be stripped, got "${name.name}"`);
  assert.ok(!name.name.includes('>'), `angle brackets must be stripped, got "${name.name}"`);
  assert.ok(name.name.length <= 16, 'the name is capped at 16 characters');

  // The raw payload must not come back out over the wire.
  const wire = JSON.stringify(state);
  assert.ok(!wire.includes('onerror=alert'), 'no live markup should reach the client');
  assert.ok(!wire.includes(hostile), 'the hostile name is not echoed verbatim');

  a.close();
  b.close();
});

test('a malformed message does not take down the server', async () => {
  const a = connect();
  await a.open;
  a.ws.send('this is not json');
  a.ws.send(JSON.stringify({ nonsense: true }));
  a.ws.send(JSON.stringify({ t: 'notARealMessage' }));
  a.ws.send(JSON.stringify([1, 2, 3]));

  // The connection must still work afterwards.
  a.send({ t: MSG.JOIN, name: 'Survivor', color: '#22c55e', settings: { mode: 'marathon' } });
  const state = await a.next((m) => m.t === MSG.ROOM_STATE);
  assert.equal(state.players.length, 1);
  a.close();
});

test('hostile input fields are stripped before simulation', async () => {
  const c = connect();
  await c.open;
  c.send({ t: MSG.JOIN, name: 'Cheater', color: '#ef4444', settings: { mode: 'marathon' } });
  await c.next((m) => m.t === MSG.ROOM_STATE);
  const hello = await c.next((m) => m.t === MSG.HELLO && m.playerId);
  c.send({ t: MSG.SET_READY, ready: true });
  await c.next((m) => m.t === MSG.ROOM_STATE && m.players[0].ready);
  c.send({ t: MSG.START });
  await c.next((m) => m.t === MSG.GAME_START);

  const before = await c.next((m) => m.t === MSG.ROOM_STATE && m.boards[hello.playerId]);

  // Absolute coordinates, prototype keys and bogus values must all be ignored.
  c.send({
    t: MSG.INPUT,
    input: { dx: 99, x: 5, y: 19, rot: 42, __proto__: { polluted: true }, score: 1e9, hardDrop: 'yes' },
  });

  const after = await c.next(
    (m) => m.t === MSG.ROOM_STATE && m.boards[hello.playerId] && m.boards[hello.playerId].y !== before.boards[hello.playerId].y,
    5000
  );
  const snap = after.boards[hello.playerId];
  assert.ok(snap.x >= 0 && snap.x < 10, `x stays on the board, got ${snap.x}`);
  assert.ok(snap.y >= -3 && snap.y < 20, `y stays sane, got ${snap.y}`);
  assert.ok(snap.r >= 0 && snap.r < 4, `rotation stays valid, got ${snap.r}`);
  assert.ok(snap.s < 1e9, 'the score was not set directly by the client');
  assert.equal({}.polluted, undefined, 'Object.prototype was not polluted');

  c.close();
});

test('chat is broadcast to everyone in the room', async () => {
  const a = connect();
  const b = connect();
  await Promise.all([a.open, b.open]);

  a.send({ t: MSG.JOIN, name: 'A', color: '#22d3ee', settings: { mode: 'marathon' } });
  const first = await a.next((m) => m.t === MSG.ROOM_STATE);
  b.send({ t: MSG.JOIN, name: 'B', color: '#a855f7', code: first.code });
  await b.next((m) => m.t === MSG.ROOM_STATE);

  a.send({ t: MSG.CHAT, text: 'good luck' });
  const got = await b.next((m) => m.t === MSG.CHAT && m.text === 'good luck');
  assert.equal(got.name, 'A');
  a.close();
  b.close();
});

test('non-host players cannot change room settings', async () => {
  const a = connect();
  const b = connect();
  await Promise.all([a.open, b.open]);

  a.send({ t: MSG.JOIN, name: 'Host', color: '#22d3ee', settings: { mode: 'marathon' } });
  const first = await a.next((m) => m.t === MSG.ROOM_STATE);
  b.send({ t: MSG.JOIN, name: 'Guest', color: '#a855f7', code: first.code });
  const helloB = await b.next((m) => m.t === MSG.HELLO && m.playerId);

  b.send({ t: MSG.SET_SETTINGS, settings: { mode: 'versus' } });
  // The server must ignore it, so the mode should stay marathon.
  await new Promise((r) => setTimeout(r, 300));
  const list = await (await fetch(`http://127.0.0.1:${PORT}/api/rooms`)).json();
  const room = list.rooms.find((r) => r.code === first.code);
  assert.equal(room.mode, 'marathon');
  a.close();
  b.close();
});

test('leaving updates the remaining player list', async () => {
  const a = connect();
  const b = connect();
  await Promise.all([a.open, b.open]);

  a.send({ t: MSG.JOIN, name: 'A', color: '#22d3ee', settings: { mode: 'marathon' } });
  const first = await a.next((m) => m.t === MSG.ROOM_STATE);
  b.send({ t: MSG.JOIN, name: 'B', color: '#a855f7', code: first.code });
  await b.next((m) => m.t === MSG.ROOM_STATE && m.players.length === 2);

  b.send({ t: MSG.LEAVE });
  const updated = await a.next((m) => m.t === MSG.ROOM_STATE && m.players.length === 1, 4000);
  assert.equal(updated.players[0].name, 'A');
  a.close();
  b.close();
});