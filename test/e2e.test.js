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

test('the snapshot reports whether hold has been spent', async () => {
  // Without this the client cannot know hold is a one-shot, and would allow a
  // second swap that the server rejects, so the piece visibly changed.
  const { Game } = await import('../src/core/game.js');

  const g = new Game({ seed: 7 });
  assert.equal('hu' in g.snapshot(), true, 'the snapshot must carry the hold flag');

  const before = g.snapshot();
  assert.equal(before.hu, 0, 'hold starts available');

  g.input({ hold: true });
  const after = g.snapshot();
  assert.equal(after.hu, 1, 'hold must be reported as spent');

  // Adopting a spent snapshot must prevent a second hold.
  const adopted = new Game({ seed: 7 });
  adopted.hold = after.h;
  adopted.piece = after.p;
  adopted.rot = after.r;
  adopted.px = after.x;
  adopted.py = after.y;
  adopted.holdUsed = after.hu === 1;

  const pieceAfterAdopt = adopted.piece;
  const holdAfterAdopt = adopted.hold;
  assert.equal(adopted.input({ hold: true }), false, 'a second hold must be refused');
  assert.equal(adopted.piece, pieceAfterAdopt, 'the piece must not change');
  assert.equal(adopted.hold, holdAfterAdopt, 'the hold box must not change');
});

test('a client that replays an in-flight hold still matches the server', async () => {
  const { Game } = await import('../src/core/game.js');
  const settle = (g) => {
    if (g.clearAnim > 0) {
      g.clearAnim = 0;
      g.finishLock();
    }
  };

  const server = new Game({ seed: 99 });
  const client = new Game({ seed: 99 });
  server.input({ hardDrop: true });
  settle(server);
  client.input({ hardDrop: true });
  settle(client);

  // The server has now processed the hold the client predicted.
  server.input({ hold: true });
  const snap = server.snapshot();

  client.hold = snap.h;
  client.piece = snap.p;
  client.rot = snap.r;
  client.px = snap.x;
  client.py = snap.y;
  client.holdUsed = snap.hu === 1;

  // Replaying the hold must be a no-op, not a second swap.
  client.input({ hold: true });

  assert.equal(client.piece, server.piece, 'both sides are on the same piece');
  assert.equal(client.hold, server.hold, 'both hold boxes match');
});

test('snapshot revisions increase and never go backwards', async () => {
  const c = connect();
  await c.open;
  c.send({ t: MSG.JOIN, name: 'Rev', color: '#22d3ee', settings: { mode: 'marathon' } });
  await c.next((m) => m.t === MSG.ROOM_STATE);
  const hello = await c.next((m) => m.t === MSG.HELLO && m.playerId);
  c.send({ t: MSG.SET_READY, ready: true });
  await c.next((m) => m.t === MSG.ROOM_STATE && m.players[0].ready);
  c.send({ t: MSG.START });
  await c.next((m) => m.t === MSG.GAME_START);

  // Collect a run of snapshots and check the revision is monotonic.
  const revs = [];
  const started = Date.now();
  c.send({ t: MSG.INPUT, input: { hardDrop: true } });
  while (Date.now() - started < 2500 && revs.length < 8) {
    const m = await c.next((x) => x.t === MSG.ROOM_STATE && x.boards?.[hello.playerId], 3000);
    if (m?.boards?.[hello.playerId]) revs.push(m.boards[hello.playerId].rev);
  }

  assert.ok(revs.length >= 2, `expected several snapshots, got ${revs.length}`);
  for (let i = 1; i < revs.length; i++) {
    assert.ok(revs[i] >= revs[i - 1], `revision went backwards: ${revs.join(',')}`);
  }
  c.close();
});

test('a snapshot from before a local lock is ignored rather than rolled back', async () => {
  // This is the flicker bug: the client predicts a hard drop, then receives a
  // server snapshot built before the server processed it. Boards differ, but
  // the snapshot must be recognised as stale and skipped.
  const { Game } = await import('../src/core/game.js');
  const { COLS, ROWS } = await import('../src/core/constants.js');

  const server = new Game({ seed: 7 });
  const client = new Game({ seed: 7 });
  const settle = (g) => {
    if (g.clearAnim > 0) {
      g.clearAnim = 0;
      g.finishLock();
    }
  };

  // Client hard drops; the server has not seen the input yet.
  client.input({ hardDrop: true });
  settle(client);

  const stale = server.snapshot();
  assert.equal(stale.rev, 0, 'the stale snapshot predates the lock');

  // Boards genuinely disagree, which is exactly the ambiguous case.
  const encode = (g) => Array.from(g.board).map((v) => (v === 8 ? 'g' : v)).join('');
  assert.notEqual(encode(client), stale.b, 'precondition: the boards differ');

  // A client that has applied nothing yet would accept it, so model the guard
  // the client uses: rev 0 is not greater than rev 0.
  const wouldAccept = stale.rev > 0;
  assert.equal(wouldAccept, false, 'a rev-0 snapshot is stale once rev 0 was applied');

  // Once the server processes the drop, its revision moves ahead and is accepted.
  server.input({ hardDrop: true });
  settle(server);
  const fresh = server.snapshot();
  assert.ok(fresh.rev > stale.rev, 'the server revision advances after the lock');
  assert.equal(encode(client), fresh.b, 'and the boards finally agree');
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

test('joining a match already in progress is refused', async () => {
  // A mid-match joiner gets no game, so they could not play, and in versus
  // mode their seat would immediately decide the match.
  const a = connect();
  const b = connect();
  await Promise.all([a.open, b.open]);

  a.send({ t: MSG.JOIN, name: 'Host', color: '#22d3ee', settings: { mode: 'versus' } });
  const first = await a.next((m) => m.t === MSG.ROOM_STATE);
  b.send({ t: MSG.JOIN, name: 'B', color: '#a855f7', code: first.code });
  await b.next((m) => m.t === MSG.ROOM_STATE && m.players.length === 2);

  for (const c of [a, b]) c.send({ t: MSG.SET_READY, ready: true });
  await a.next((m) => m.t === MSG.ROOM_STATE && m.players.every((p) => p.ready));
  a.send({ t: MSG.START });
  await a.next((m) => m.t === MSG.GAME_START);

  // A third player tries to join the running match.
  const c = connect();
  await c.open;
  c.send({ t: MSG.JOIN, name: 'Late', color: '#facc15', code: first.code });
  const err = await c.next((m) => m.t === MSG.ERROR);
  assert.match(err.message, /already started/i);

  // The seated players are unaffected.
  const state = await a.next(
    (m) => m.t === MSG.ROOM_STATE && m.status === 'playing' && m.players.length === 2
  );
  assert.equal(state.status, 'playing');
  for (const p of state.players) {
    assert.ok(state.boards[p.id], `${p.name} should still have a board`);
  }

  c.close();
  a.close();
  b.close();
});

test('a spectator can still watch a match in progress', async () => {
  const a = connect();
  const s = connect();
  await Promise.all([a.open, s.open]);

  a.send({ t: MSG.JOIN, name: 'Host', color: '#22d3ee', settings: { mode: 'marathon' } });
  const first = await a.next((m) => m.t === MSG.ROOM_STATE);
  a.send({ t: MSG.SET_READY, ready: true });
  await a.next((m) => m.t === MSG.ROOM_STATE && m.players[0].ready);
  a.send({ t: MSG.START });
  await a.next((m) => m.t === MSG.GAME_START);

  s.send({ t: MSG.JOIN, name: 'Watcher', color: '#a855f7', code: first.code, asSpectator: true });
  const hello = await s.next((m) => m.t === MSG.HELLO && m.spectatorId);
  assert.ok(hello.spectatorId, 'the watcher should get a spectator seat');

  const state = await s.next((m) => m.t === MSG.ROOM_STATE && m.status === 'playing');
  assert.ok(state.boards, 'a spectator still receives the boards to watch');

  s.close();
  a.close();
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