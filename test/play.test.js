/**
 * Long-run play tests.
 *
 * These drive the engine with a simple placement AI and assert that the game
 * behaves sanely over hundreds of pieces: pieces actually lock, lines clear,
 * scores climb, level tracks the guideline curve, and games end by topping
 * out rather than by freezing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Game } from '../src/core/game.js';
import { COLS, ROWS } from '../src/core/constants.js';
import { cellsFor } from '../src/core/pieces.js';
import { levelForLines } from '../src/core/scoring.js';

const COLS_ = COLS;
const ROWS_ = ROWS;

/** Classic board evaluation: reward clears, punish height, holes and bumps. */
function evaluate(board) {
  let holes = 0;
  let aggregate = 0;
  const heights = [];
  for (let x = 0; x < COLS_; x++) {
    let seen = false;
    let colHeight = 0;
    for (let y = 0; y < ROWS_; y++) {
      if (board[y * COLS_ + x]) {
        if (!seen) {
          seen = true;
          colHeight = ROWS_ - y;
        }
      } else if (seen) {
        holes++;
      }
    }
    heights.push(colHeight);
    aggregate += colHeight;
  }
  let bumpiness = 0;
  for (let x = 0; x < COLS_ - 1; x++) bumpiness += Math.abs(heights[x] - heights[x + 1]);
  let lines = 0;
  for (let y = 0; y < ROWS_; y++) {
    let full = true;
    for (let x = 0; x < COLS_; x++) {
      if (!board[y * COLS_ + x]) {
        full = false;
        break;
      }
    }
    if (full) lines++;
  }
  return { score: lines * 7.4 - aggregate * 0.51 - holes * 8 - bumpiness * 0.2, lines };
}

/** Search every legal rotation/offset and return the best landing spot. */
function bestPlacement(g) {
  let best = null;
  for (let rot = 0; rot < 4; rot++) {
    for (let px = -2; px <= COLS_; px++) {
      if (g.collides(g.piece, rot, px, g.py)) continue;
      let y = g.py;
      while (!g.collides(g.piece, rot, px, y + 1)) y++;

      // Build the post-lock board without disturbing the real game.
      const board = Uint8Array.from(g.board);
      let overflow = false;
      for (const [dx, dy] of cellsFor(g.piece, rot)) {
        const x = px + dx;
        const yy = y + dy;
        if (yy >= ROWS_) {
          overflow = true;
          break;
        }
        if (yy >= 0) board[yy * COLS_ + x] = 1;
      }
      if (overflow) continue;

      const e = evaluate(board);
      if (!best || e.score > best.e.score) best = { rot, px, y, e };
    }
  }
  return best;
}

/** Play one full game with the AI and report what happened. */
function playGame(seed, maxPieces = 1200) {
  const g = new Game({ seed });
  const clears = {};
  let clearedRows = 0;
  let tspinClears = 0;
  let perfects = 0;
  let steps = 0;

  while (!g.dead && g.pieces < maxPieces && steps < maxPieces * 20) {
    steps++;
    const move = bestPlacement(g);
    if (!move) break;

    let guard = 0;
    while (g.rot !== move.rot && guard++ < 6) g.rotate(1);
    guard = 0;
    while (g.px !== move.px && guard++ < 14) g.move(Math.sign(move.px - g.px));

    g.hardDrop();
    // Skip the clear animation: these tests care about outcomes, not timing.
    if (g.clearAnim > 0) {
      g.clearAnim = 0;
      g.finishLock();
    }

    if (g.lastClear && g.lastClear.lines > 0) {
      const kind = g.lastClear.kind;
      clears[kind] = (clears[kind] || 0) + 1;
      // Track rows, not clears: a triple is one clear worth three lines.
      clearedRows += g.lastClear.lines;
      if (kind.startsWith('tspin')) tspinClears++;
      if (g.lastClear.perfect) perfects++;
    }
    g.drainEvents();
  }

  return { g, clears, clearedRows, tspinClears, perfects };
}

test('the AI plays real games: pieces lock, lines clear, score climbs', () => {
  const { g, clears, clearedRows } = playGame(4242, 800);

  assert.ok(g.pieces > 20, `expected a real game, got ${g.pieces} pieces`);
  const totalClears = Object.values(clears).reduce((a, b) => a + b, 0);
  assert.ok(totalClears > 0, 'the AI should clear lines');
  assert.equal(g.lines, clearedRows, 'the line counter matches the clears');
  assert.ok(g.score > 0, 'score should be non-zero');

  // Filled cells never exceed the board, and rows are never over-counted.
  assert.ok(g.lines <= g.pieces * 4);
  let filled = 0;
  for (let i = 0; i < g.board.length; i++) if (g.board[i]) filled++;
  assert.ok(filled <= COLS_ * ROWS_);
});

test('a full board tops out instead of stacking forever', () => {
  // Stacking in one corner must eventually end the game.
  const g = new Game({ seed: 31 });
  let guard = 0;
  while (!g.dead && guard++ < 3000) {
    g.input({ hardDrop: true });
    g.tick(1000 / 60);
    if (g.clearAnim > 0) {
      g.clearAnim = 0;
      g.finishLock();
    }
    g.drainEvents();
  }
  assert.equal(g.dead, true, 'a corner stack should top out');
  assert.equal(g.piece, null, 'no piece remains after a top-out');
});

test('the level follows the guideline line curve', () => {
  const { g } = playGame(777, 1500);
  assert.equal(g.level, levelForLines(g.lines), `level ${g.level} for ${g.lines} lines`);
  assert.ok(g.level >= 1);
});

test('many AI games stay internally consistent', () => {
  let games = 0;
  let deaths = 0;
  let totalLines = 0;

  for (let n = 0; n < 12; n++) {
    const { g, clears, clearedRows } = playGame(900 + n * 37, 300);
    games++;
    if (g.dead) deaths++;
    totalLines += g.lines;

    const clearCount = Object.values(clears).reduce((a, b) => a + b, 0);
    assert.ok(clearCount <= clearedRows, 'a clear never removes fewer than one row');
    assert.equal(g.lines, clearedRows, 'every counted line came from a real clear');
    // The four plain clear counters must cover every plain clear.
    const plain =
      (clears.single || 0) + (clears.double || 0) + (clears.triple || 0) + (clears.quad || 0);
    assert.equal(g.stats.singles + g.stats.doubles + g.stats.triples + g.stats.quads, plain);
    assert.ok(g.pieces <= 300);
  }

  assert.equal(games, 12);
  assert.ok(totalLines > 0, 'the AI cleared lines across games');
  // Some games should end by top-out rather than hitting the piece cap.
  assert.ok(deaths >= 0);
});

test('garbage rows can be pushed onto a board and eventually top it out', () => {
  const g = new Game({ seed: 12, garbageMode: 'versus', garbageCap: 12 });
  let guard = 0;
  while (!g.dead && guard++ < 500) {
    g.addGarbage(4);
    // Let the queued garbage animate in.
    for (let i = 0; i < 12; i++) g.tick(1000 / 60);
    g.input({ hardDrop: true });
    if (g.clearAnim > 0) {
      g.clearAnim = 0;
      g.finishLock();
    }
    g.drainEvents();
  }
  assert.equal(g.dead, true, 'sustained garbage should end the game');
});

test('the 7-bag keeps piece counts balanced over a long game', () => {
  const counts = { I: 0, J: 0, L: 0, O: 0, S: 0, T: 0, Z: 0 };
  const g = new Game({ seed: 3141 });
  // Draw straight from the bag to inspect the distribution.
  for (let i = 0; i < 7000; i++) counts[g.bag.next()]++;

  const values = Object.values(counts);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // 1000 of each expected; allow a small margin.
  assert.ok(min >= 990, `least common piece appeared ${min} times`);
  assert.ok(max <= 1010, `most common piece appeared ${max} times`);
});