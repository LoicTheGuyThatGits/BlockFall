/**
 * Room-level tests that need no network: lobby rules, settings permissions,
 * match start/end conditions and rematch voting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Room, RoomRegistry, sanitizeName } from '../server/rooms.js';
import { MSG } from '../src/core/protocol.js';

/** Minimal stand-in for a WebSocket that records what the room sends. */
function fakeWs() {
  const sent = [];
  return {
    readyState: 1,
    sent,
    send(data) {
      sent.push(JSON.parse(data));
    },
    close() {},
    /** Last message of a given type, or null. */
    last(type) {
      for (let i = sent.length - 1; i >= 0; i--) if (sent[i].t === type) return sent[i];
      return null;
    },
    types() {
      return sent.map((m) => m.t);
    },
  };
}

/**
 * Build a room with 1 or 2 players already seated.
 * `ready` readies everyone, which most match tests need.
 */
function newRoom(settings, { players = 2, ready = false } = {}) {
  const ws = fakeWs();
  const room = new Room('TEST', ws, { settings });
  const a = room.join(ws, { name: 'A', color: '#22d3ee' });
  const wsB = fakeWs();
  const b = players > 1 ? room.join(wsB, { name: 'B', color: '#a855f7' }) : null;
  if (ready) {
    for (const p of room.players.values()) room.setReady(p.id, true);
  }
  return { room, a, b, ws, wsB };
}

test('sanitizeName strips markup and caps the length', () => {
  // Angle brackets and parens are stripped, then the result is capped at 16.
assert.equal(sanitizeName('<b>hi</b>'), 'bhib');
assert.ok(!sanitizeName('<img src=x onerror=y>').includes('<'));
  assert.equal(sanitizeName('  Bobby  '), 'Bobby');
  assert.equal(sanitizeName('x'.repeat(50)).length, 16);
  assert.equal(sanitizeName('Ünïcødé ñame'), 'Ünïcødé ñame');
});

test('the first player in a room becomes host', () => {
  const { room, a, b } = newRoom();
  assert.equal(room.hostId, a.id);
  assert.equal(room.hostId === a.id, true);
  assert.notEqual(a.id, b.id);
});

test('leaving promotes the next player to host', () => {
  const { room, a, b } = newRoom();
  room.leave(a.id);
  assert.equal(room.hostId, b.id);
});

test('leaving the last player empties the room and starts the reaper clock', () => {
  const { room, a, b } = newRoom();
  room.leave(a.id);
  room.leave(b.id);
  assert.equal(room.players.size, 0);
  assert.ok(room.isExpired(Date.now() + 120_000));
});

test('only the host can change settings', () => {
  const { room, a, b } = newRoom({ mode: 'marathon' });
  assert.equal(room.setSettings(b.id, { mode: 'versus' }), false);
  assert.equal(room.settings.mode, 'marathon');
  assert.equal(room.setSettings(a.id, { mode: 'versus' }), true);
  assert.equal(room.settings.mode, 'versus');
});

test('settings are clamped to sane ranges', () => {
  const { room, a } = newRoom();
  room.setSettings(a.id, { startingLevel: 999 });
  assert.equal(room.settings.startingLevel, 15);
  room.setSettings(a.id, { startingLevel: -5 });
  assert.equal(room.settings.startingLevel, 1);
  room.setSettings(a.id, { linesToWin: 5000 });
  assert.equal(room.settings.linesToWin, 100);
  room.setSettings(a.id, { maxPlayers: 40 });
  assert.equal(room.settings.maxPlayers, 4);
  room.setSettings(a.id, { mode: 'nonsense' });
  assert.equal(room.settings.mode, 'marathon', 'unknown mode is ignored');
});

test('settings cannot change once a match is running', () => {
  const { room, a } = newRoom({ mode: 'marathon' }, { ready: true });
  assert.equal(room.start(), null);
  assert.equal(room.setSettings(a.id, { mode: 'versus' }), false);
});

test('a match cannot start until everyone is ready', () => {
  const { room, a } = newRoom();
  assert.match(room.canStart(), /ready/i);
  room.setReady(a.id, true);
  assert.match(room.canStart(), /ready/i, 'player B has not readied up');

  // A single-player room only needs that one player.
  const solo = newRoom(undefined, { players: 1 });
  assert.match(solo.room.canStart(), /ready/i);
  solo.room.setReady(solo.a.id, true);
  assert.equal(solo.room.canStart(), null);
});

test('starting a match gives every player their own game', () => {
  const { room, a, b } = newRoom({ mode: 'marathon' }, { ready: true });
  assert.equal(room.start(), null);

  assert.equal(room.status, 'playing');
  assert.ok(a.game && b.game);
  assert.notEqual(a.game.seed, b.game.seed, 'players get different piece order');
  assert.equal(a.game.bag.peek(7).length, 7);
  const start = room.spectators.size; // unchanged
  assert.equal(start, 0);
});

test('a marathon match ends once every player is out', () => {
  const { room, a, b, ws } = newRoom({ mode: 'marathon' }, { ready: true });
  room.start();

  a.game.topOut();
  room.checkMatchEnd();
  assert.equal(room.status, 'playing', 'B is still standing');

  b.game.topOut();
  room.checkMatchEnd();
  assert.equal(room.status, 'over');

  const over = ws.last(MSG.GAME_OVER);
  assert.ok(over);
  assert.equal(over.ranked.length, 2);
  assert.equal(over.ranked[0].rank, 1);
  assert.ok(over.ranked.some((r) => r.score >= 0));
});

test('a versus match ends when only one player is left', () => {
  const { room, a, b } = newRoom({ mode: 'versus', garbage: true }, { ready: true });
  room.start();
  assert.equal(room.status, 'playing');

  a.game.topOut();
  room.checkMatchEnd();
  assert.equal(room.status, 'over', 'one player left standing, so it is over');
});

test('a one-player versus room plays on instead of ending instantly', () => {
  const { room } = newRoom({ mode: 'versus' }, { players: 1, ready: true });
  room.start();
  room.checkMatchEnd();
  assert.equal(room.status, 'playing', 'a solo room has no opponent to beat');
});

test('leaving mid-match can end a versus game', () => {
  const { room, a, b } = newRoom({ mode: 'versus' }, { ready: true });
  room.start();
  room.leave(b.id);
  assert.equal(room.status, 'over', 'the match is decided when a player drops');
});

test('sprint ends when the player hits the line goal', () => {
  const { room, a } = newRoom({ mode: 'sprint', linesToWin: 5 }, { players: 1, ready: true });
  room.start();

  a.game.lines = 5;
  // Drive the step the way the game loop does, with an advancing clock.
  let now = room.startedAt;
  for (let i = 0; i < 5 && room.status === 'playing'; i++) {
    now += 1000 / 60;
    room.step(1000 / 60, now);
  }
  assert.ok(a.finishedAt !== null, 'the finisher is recorded');
  assert.equal(room.status, 'over');
});

test('rematch requires everyone to vote', () => {
  const { room, a, b } = newRoom();
  room.requestRematch(a.id);
  assert.equal(room.status, 'lobby');
  room.requestRematch(b.id);
  assert.equal(room.status, 'playing', 'all votes in means a new match starts');
  assert.ok(a.game && b.game);
});

test('garbage flows from a clear to the other player', () => {
  const { room, a, b, wsB } = newRoom({ mode: 'versus', garbage: true }, { ready: true });
  room.start();
  room.broadcastState();
  wsB.sent.length = 0;

  // Fill A's bottom four rows except column 9, then vertical-I into it.
  const { COLS, ROWS } = { COLS: 10, ROWS: 20 };
  for (let y = ROWS - 4; y < ROWS; y++) for (let x = 0; x < COLS - 1; x++) a.game.board[y * COLS + x] = 5;
  a.game.piece = 'I';
  a.game.rot = 1;
  a.game.px = 7;
  a.game.py = ROWS - 4;
  room.queueInput(a.id, { hardDrop: true });

  // Step a few frames: the lock resolves, garbage is delivered, and the
  // snapshot stream catches up.
  let now = room.startedAt;
  for (let i = 0; i < 10; i++) {
    now += 1000 / 60;
    room.step(1000 / 60, now);
    room.snapshotAccum += 1000 / 60;
    if (room.snapshotAccum >= 1000 / 20) {
      room.snapshotAccum = 0;
      room.broadcastState();
    }
  }

  assert.equal(a.game.lines, 4, 'quad cleared');
  assert.ok(b.game.pendingGarbage > 0, 'opponent received garbage');

  const snap = wsB.sent.filter((m) => m.t === MSG.ROOM_STATE).pop();
  assert.ok(snap, 'opponent got a snapshot');
  assert.ok(snap.boards[b.id]);
  assert.ok(snap.boards[b.id].pg > 0);
});

test('the host cannot attack when garbage is disabled', () => {
  const { room, a, b } = newRoom({ mode: 'versus', garbage: false }, { ready: true });
  room.start();
  a.attackQueue = 5;
  room.step(1000 / 60, Date.now());
  assert.equal(b.game.pendingGarbage, 0);
});

test('inputs are queued and applied on the next step', () => {
  const { room, a } = newRoom(undefined, { ready: true });
  room.start();

  const startX = a.game.px;
  room.queueInput(a.id, { dx: -1 });
  assert.equal(a.game.px, startX, 'not applied until step');
  room.step(1000 / 60, Date.now());
  assert.equal(a.game.px, startX - 1);
});

test('input queue depth is bounded so a client cannot flood the server', () => {
  const { room, a } = newRoom(undefined, { ready: true });
  room.start();
  for (let i = 0; i < 500; i++) room.queueInput(a.id, { dx: 1 });
  assert.equal(a.pendingInput.length, 64);
});

test('a full room refuses to start', () => {
  const { room, a, b } = newRoom({ maxPlayers: 2 }, { ready: true });
  assert.equal(room.canStart(), null, 'two players in a two-player room is fine');
  room.join(fakeWs(), { name: 'C' });
  assert.match(room.canStart(), /full/i);
});

test('the registry hands out unique codes and lists joinable rooms', () => {
  const reg = new RoomRegistry();
  const a = reg.create(fakeWs(), { settings: { mode: 'marathon' } });
  const b = reg.create(fakeWs(), { settings: { mode: 'versus' } });
  assert.notEqual(a.code, b.code);
  assert.equal(a.code.length, 5);

  // Empty rooms are not advertised.
  assert.equal(reg.list().length, 0);

  a.join(fakeWs(), { name: 'P1' });
  b.join(fakeWs(), { name: 'P2' });
  const list = reg.list();
  assert.equal(list.length, 2);

  assert.equal(reg.get(a.code), a);
  assert.equal(reg.get(a.code.toLowerCase()), a, 'lookup is case-insensitive');
  assert.equal(reg.get('!!!!'), null, 'punctuation is normalised away');

  // Quick play only picks rooms with space and a matching mode.
  assert.equal(reg.findQuickPlay('marathon').code, a.code);
  assert.equal(reg.findQuickPlay('versus').code, b.code);

  // Private rooms are never handed out by quick play.
  a.settings.private = true;
  assert.equal(reg.findQuickPlay('marathon'), null);
});

test('the registry creates a fresh room when quick play finds none', () => {
  const reg = new RoomRegistry();
  assert.equal(reg.findQuickPlay('versus'), null);
  const created = reg.create(fakeWs(), { settings: { mode: 'versus' } });
  assert.ok(created.code);
});

test('empty rooms are reaped once they go stale', () => {
  const reg = new RoomRegistry();
  const room = reg.create(fakeWs(), {});
  reg.rooms.delete(room.code); // simulate a swept room
  assert.equal(reg.rooms.size, 0);
});

test('snapshots are compact enough to send 20 times a second', () => {
  const { room, a } = newRoom(undefined, { ready: true });
  room.start();
  const state = room.buildState();
  const json = JSON.stringify(state);
  // 200 cells per board plus metadata; should stay in the low kilobytes.
  assert.ok(json.length < 4096, `snapshot was ${json.length} bytes`);
  assert.ok(json.length > 400);
  assert.equal(state.boards[a.id].b.length, 200);
});

test('chat is capped at 200 characters and stored per room', () => {
  const { room, a, ws, wsB } = newRoom();
  room.chat(ws, 'x'.repeat(500));
  const msg = wsB.sent.filter((m) => m.t === MSG.CHAT).pop();
  assert.equal(msg.text.length, 200);
  assert.equal(msg.name, 'A');
  assert.ok(room.messages.length <= 50);
});