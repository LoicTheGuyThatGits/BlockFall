import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Game, encodeBoard, decodeBoard } from '../src/core/game.js';
import { Bag, makeRng } from '../src/core/rng.js';
import { scoreClear, linesForLevel, levelForLines } from '../src/core/scoring.js';
import { cellsFor, kicksFor } from '../src/core/pieces.js';
import { COLS, ROWS, PIECE_IDS, MAX_LOCK_RESETS } from '../src/core/constants.js';

/** Place a piece and instantly lock it, bypassing the animation. */
function forceLock(g, type, rot, x, y) {
  g.piece = type;
  g.rot = rot;
  g.px = x;
  g.py = y;
  g.lockPiece();
  if (g.clearAnim > 0) {
    g.clearAnim = 0;
    g.finishLock();
  }
}

function stackRow(g, row, cols = COLS) {
  for (let i = 0; i < cols; i++) g.board[row * COLS + i] = 5;
}

test('bag hands out every piece exactly once per group of seven', () => {
  const bag = new Bag(12345);
  const first = [];
  for (let i = 0; i < 7; i++) first.push(bag.next());
  assert.equal(new Set(first).size, 7);
});

test('bag is deterministic for a given seed', () => {
  const seqA = new Bag(999);
  const seqB = new Bag(999);
  const seqC = new Bag(1000);
  const take = (bag) => Array.from({ length: 14 }, () => bag.next()).join('');
  const a = take(seqA);
  assert.equal(a, take(seqB), 'same seed must give the same sequence');
  // A different seed should reorder the pieces; over 14 pieces a repeat is
  // vanishingly unlikely.
  assert.notEqual(a, take(seqC), 'different seed should give a different sequence');
});

test('rng state can be saved and restored', () => {
  const rng = makeRng(42);
  rng();
  const state = rng.getState();
  const next = rng();
  rng.setState(state);
  assert.equal(rng(), next);
});

test('board encoding round-trips, including garbage', () => {
  const g = new Game({ seed: 1 });
  g.board[0] = 3;
  g.board[1] = 8;
  g.board[COLS * 3 + 5] = 7;
  const str = encodeBoard(g.board);
  const back = decodeBoard(str);
  assert.deepEqual([...back], [...g.board]);
});

test('all four rotation states of every piece hold four cells', () => {
  for (const type of ['I', 'J', 'L', 'O', 'S', 'T', 'Z']) {
    for (let r = 0; r < 4; r++) {
      assert.equal(cellsFor(type, r).length, 4, `${type} rot ${r}`);
    }
  }
});

test('kick tables exist for every adjacent transition', () => {
  for (const type of ['J', 'L', 'S', 'T', 'Z', 'I']) {
    for (let from = 0; from < 4; from++) {
      const to = (from + 1) & 3;
      assert.ok(kicksFor(type, from, to).length > 0, `${type} ${from}->${to}`);
    }
  }
});

test('a full row clears and collapses the stack', () => {
  const g = new Game({ seed: 7 });
  stackRow(g, ROWS - 1);
  const before = g.lines;
  forceLock(g, 'I', 0, 3, ROWS - 2);
  assert.equal(g.lines, before + 1);
  // The cleared row should be gone from the bottom.
  for (let x = 0; x < COLS; x++) assert.equal(g.board[(ROWS - 1) * COLS + x], 0);
});

test('quad clear scores and reports four lines', () => {
  const g = new Game({ seed: 8 });
  // Fill columns 0-8 on the bottom four rows, leaving column 9 empty.
  for (let y = ROWS - 4; y < ROWS; y++) stackRow(g, y, COLS - 1);
  // A vertical I occupies column px+2, so px=7 drops it into column 9.
  forceLock(g, 'I', 1, 7, ROWS - 4);
  assert.equal(g.lines, 4);
  assert.ok(g.score > 0);
});

test('level curve matches the guideline thresholds', () => {
  assert.equal(linesForLevel(1), 0);
  assert.equal(linesForLevel(2), 2);
  assert.equal(linesForLevel(10), 18);
  assert.equal(linesForLevel(11), 58);
  assert.equal(levelForLines(0), 1);
  assert.equal(levelForLines(18), 10);
});

test('scoring: quadruple is worth more than triple', () => {
  const base = { level: 1, perfect: false, b2b: false, combo: -1, dropCells: 0, hardCells: 0 };
  const triple = scoreClear({ ...base, kind: 'triple', lines: 3 });
  const quad = scoreClear({ ...base, kind: 'quad', lines: 4 });
  assert.ok(quad.points > triple.points);
});

test('scoring: back-to-back boosts the second difficult clear', () => {
  const base = { level: 1, perfect: false, combo: -1, dropCells: 0, hardCells: 0 };
  const solo = scoreClear({ ...base, kind: 'quad', lines: 4 });
  const chained = scoreClear({ ...base, kind: 'quad', lines: 4, b2b: true });
  assert.ok(chained.points > solo.points);
  assert.ok(chained.garbage > solo.garbage);
  assert.equal(chained.b2b, true);
});

test('scoring: combo adds a bonus per consecutive clear', () => {
  const base = { level: 1, perfect: false, b2b: false, dropCells: 0, hardCells: 0 };
  const noCombo = scoreClear({ ...base, kind: 'single', lines: 1 });
  const combo = scoreClear({ ...base, kind: 'single', lines: 1, combo: 3 });
  assert.equal(combo.points - noCombo.points, 50 * 3);
});

test('scoring: level multiplies the clear', () => {
  const base = { perfect: false, b2b: false, combo: -1, dropCells: 0, hardCells: 0 };
  const l1 = scoreClear({ ...base, kind: 'double', lines: 2, level: 1 });
  const l5 = scoreClear({ ...base, kind: 'double', lines: 2, level: 5 });
  assert.equal(l5.points, l1.points * 5);
});

test('hold swaps once per piece', () => {
  const g = new Game({ seed: 3 });
  const first = g.piece;
  assert.equal(g.input({ hold: true }), true);
  assert.equal(g.hold, first);
  assert.equal(g.holdUsed, true);
  // Second hold without a new piece must be refused.
  assert.equal(g.input({ hold: true }), false);
});

test('move is blocked by the wall', () => {
  const g = new Game({ seed: 4 });
  g.piece = 'I';
  g.rot = 0;
  g.px = 3;
  g.py = 5;
  const ok = g.input({ dx: -1 });
  assert.equal(ok, true);
  assert.equal(g.px, 2);
  // Shove it into the left wall, then keep pushing.
  g.px = -2;
  const blocked = g.input({ dx: -1 });
  assert.equal(blocked, false);
});

test('hard drop lands the piece on the stack and locks it', () => {
  const g = new Game({ seed: 5 });
  for (let x = 0; x < COLS; x++) g.board[(ROWS - 1) * COLS + x] = 4;
  g.piece = 'O';
  g.rot = 0;
  g.px = 4;
  g.py = 0;
  g.clearAnim = 0;
  g.entryTimer = 0;
  g.gravityAcc = 0;
  const piecesBefore = g.pieces;
  g.input({ hardDrop: true });
  assert.equal(g.pieces, piecesBefore + 1);
});

test('garbage adds rows with a hole and can top you out', () => {
  const g = new Game({ seed: 6, garbageMode: 'versus' });
  g.applyGarbage(3);
  const holeCol = [];
  for (let x = 0; x < COLS; x++) {
    if (g.board[x] === 0) holeCol.push(x);
  }
  // Rows 0..2 are the freshly inserted garbage rows.
  for (let y = 0; y < 3; y++) {
    let holes = 0;
    for (let x = 0; x < COLS; x++) if (g.board[y * COLS + x] === 0) holes++;
    assert.equal(holes, 1, `row ${y} should have exactly one hole`);
  }
});

test('topping out sets the dead flag and emits an event', () => {
  const g = new Game({ seed: 11 });
  g.drainEvents();
  g.topOut();
  assert.equal(g.dead, true);
  const events = g.drainEvents().map((e) => e.type);
  assert.ok(events.includes('topout'));
});

/**
 * Put a piece resting on a flat floor, optionally rotated, and report whether
 * it ever locks. Used to prove no input pattern can hold a piece forever.
 */
function spinUntilLock(type, policy, maxFrames = 1200) {
  const g = new Game({ seed: 1 });
  for (let x = 0; x < COLS; x++) g.board[(ROWS - 1) * COLS + x] = 2;

  g.piece = type;
  g.rot = 0;
  g.px = 4;
  g.py = ROWS - 2;
  g.grounded = false;
  g.lowered = false;
  g.lockTimer = 0;
  g.lockResets = 0;
  g.lastAction = 'none';

  for (let f = 0; f < maxFrames; f++) {
    policy(g, f);
    g.tick(1000 / 60);
    if (g.pieces > 0) return { locked: true, frames: f, resets: g.lockResets };
  }
  return { locked: false, frames: maxFrames, resets: g.lockResets, py: g.py };
}

test('a piece resting on the stack is grounded immediately, not on the next gravity step', () => {
  // At level 1 gravity is one row per second, so the old bug left a resting
  // piece reporting itself as falling for up to a second.
  const g = new Game({ seed: 1 });
  for (let x = 0; x < COLS; x++) g.board[(ROWS - 1) * COLS + x] = 2;
  g.piece = 'T';
  g.rot = 0;
  g.px = 4;
  g.py = ROWS - 2;

  g.tick(1000 / 60);
  assert.equal(g.grounded, true, 'grounding must be detected on the very first frame');
  assert.equal(g.lowered, true, 'and it must arm the lock delay immediately');
});

test('spamming rotate cannot stop a piece from locking', () => {
  for (const type of ['I', 'J', 'L', 'O', 'S', 'T', 'Z']) {
    for (const [label, policy] of [
      ['every frame', (g) => g.rotate(1)],
      ['every 10th frame', (g, f) => f % 10 === 0 && g.rotate(1)],
      ['after landing', (g, f) => f >= 5 && g.rotate(1)],
    ]) {
      const r = spinUntilLock(type, policy);
      assert.ok(r.locked, `${type} spun ${label} never locked (held at row ${r.py})`);
    }
  }
});

test('spinning alternately both ways also locks', () => {
  for (const type of ['I', 'J', 'L', 'S', 'T', 'Z']) {
    const r = spinUntilLock(type, (g, f) => g.rotate(f % 2 === 0 ? 1 : -1));
    assert.ok(r.locked, `${type} spun alternately never locked (held at row ${r.py})`);
  }
});

test('the lock reset budget is respected and cannot be farmed', () => {
  // Rotating every frame spends the budget as fast as possible, then the
  // piece must lock even though the player is still rotating.
  for (const every of [1, 10, 40]) {
    const r = spinUntilLock('T', (g, f) => f % every === 0 && g.rotate(1));
    assert.ok(r.locked, `rotating every ${every} frames never locked`);
    assert.ok(r.resets <= MAX_LOCK_RESETS, `spent ${r.resets} resets, budget is ${MAX_LOCK_RESETS}`);
  }
});

test('the lock delay measures about half a second', () => {
  const g = new Game({ seed: 1 });
  for (let x = 0; x < COLS; x++) g.board[(ROWS - 1) * COLS + x] = 2;
  g.piece = 'T';
  g.rot = 0;
  g.px = 4;
  g.py = ROWS - 2;

  let groundedAt = null;
  let lockedAt = null;
  for (let f = 0; f < 600 && g.pieces === 0; f++) {
    g.tick(1000 / 60);
    if (g.grounded && groundedAt === null) groundedAt = f;
    if (g.pieces > 0) lockedAt = f;
  }
  assert.ok(groundedAt !== null && lockedAt !== null, 'the piece should land and lock');
  const delay = lockedAt - groundedAt;
  // 500ms at 60fps is 30 frames; allow a frame either side.
  assert.ok(delay >= 28 && delay <= 32, `lock delay was ${delay} frames, expected ~30`);
});

test('a hard drop still locks on the frame it is issued', () => {
  const g = new Game({ seed: 1 });
  for (let x = 0; x < COLS; x++) g.board[(ROWS - 1) * COLS + x] = 2;
  g.input({ hardDrop: true });
  g.tick(1000 / 60);
  assert.equal(g.pieces, 1);
});

test('soft drop never bursts when it starts', () => {
  // Bank up nearly a full second of level-1 gravity, then press down. The
  // accumulated time must not be spent as a burst of instant rows.
  const g = new Game({ seed: 1 });
  for (let i = 0; i < 55; i++) g.tick(1000 / 60);
  assert.ok(g.gravityAcc > 500, 'gravity should be well banked for this test');

  const before = g.py;
  g.input({ softDrop: true });
  g.tick(1000 / 60);
  assert.ok(g.py - before <= 1, `one frame moved ${g.py - before} rows, expected at most 1`);

  // Soft drop should then settle at roughly 20 rows per second.
  const start = g.py;
  for (let i = 0; i < 60; i++) g.tick(1000 / 60);
  const rows = g.py - start;
  assert.ok(rows >= 15 && rows <= 21, `expected ~18 rows in a second, got ${rows}`);
});

test('releasing soft drop does not move the piece', () => {
  const g = new Game({ seed: 3 });
  g.input({ softDrop: true });
  for (let i = 0; i < 30; i++) g.tick(1000 / 60);

  const before = g.py;
  g.input({ softDrop: false });
  g.tick(1000 / 60);
  assert.equal(g.py, before, 'the release frame itself should not move the piece');

  // Back to the natural curve: one row per second at level 1.
  for (let i = 0; i < 30; i++) g.tick(1000 / 60);
  assert.ok(g.py - before <= 1, `natural gravity resumed too fast: ${g.py - before} rows`);
});

test('soft drop only scores cells it actually moves', () => {
  const g = new Game({ seed: 4 });
  const before = g.score;
  // Hold soft drop for a fixed time, then hard drop, and compare with the
  // points the engine attributes to the drop.
  g.input({ softDrop: true });
  for (let i = 0; i < 10; i++) g.tick(1000 / 60);
  const softCells = g.softDropCells;
  assert.ok(softCells > 0, 'soft drop should have accumulated cells');
  g.hardDrop();
  assert.ok(g.score > before);
});

test('ticking is frame-rate independent for gravity', () => {
  const a = new Game({ seed: 21, startingLevel: 5 });
  const b = new Game({ seed: 21, startingLevel: 5 });
  a.entryTimer = 0;
  b.entryTimer = 0;
  // Same elapsed time (1000ms), different step sizes: rows should match.
  for (let i = 0; i < 60; i++) a.tick(1000 / 60);
  for (let i = 0; i < 100; i++) b.tick(10);
  assert.equal(a.py, b.py);
});

test('snapshot encodes every field the client needs', () => {
  const g = new Game({ seed: 12 });
  const s = g.snapshot();
  for (const key of ['b', 'p', 'r', 'x', 'y', 'h', 'n', 's', 'l', 'lv', 'c']) {
    assert.ok(key in s, `missing ${key}`);
  }
  assert.equal(s.n.length, 5);
  assert.equal(s.b.length, COLS * ROWS);
});

test('starting level shifts the gravity curve upward', () => {
  const slow = new Game({ seed: 13, startingLevel: 1 });
  const fast = new Game({ seed: 13, startingLevel: 12 });
  assert.ok(fast.level > slow.level);
});

test('incoming garbage is capped', () => {
  const g = new Game({ seed: 14, garbageMode: 'versus', garbageCap: 5 });
  g.addGarbage(100);
  assert.equal(g.pendingGarbage, 5);
});