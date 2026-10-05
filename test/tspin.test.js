import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Game } from '../src/core/game.js';
import { COLS, ROWS } from '../src/core/constants.js';
import { scoreClear } from '../src/core/scoring.js';

/**
 * A real T-spin double shape, verified against the engine:
 *
 *   row 14  .....#.#.#
 *   row 15  ....####.#
 *   row 16  ##########
 *   row 17  ......##..
 *   row 18  .#..#....#
 *   row 19  ####...###
 *
 * The only way in is a 180 rotation at rot 2 / px 5 / py 17, which kicks the
 * T into the notch and fills two rows.
 */
const TSD_ROWS = {
  14: '.....#.#.#',
  15: '....####.#',
  16: '##########',
  17: '......##..',
  18: '.#..#....#',
  19: '####...###',
};

function makeBoard(shape = TSD_ROWS, seed = 7) {
  const g = new Game({ seed });
  g.board.fill(0);
  for (const [y, row] of Object.entries(shape)) {
    for (let x = 0; x < COLS; x++) {
      if (row[x] === '#') g.board[Number(y) * COLS + x] = 2;
    }
  }
  return g;
}

/** Drop a T-spin double: rotate into the notch, then settle it. */
function playTsd() {
  const g = makeBoard();
  g.piece = 'T';
  g.rot = 2;
  g.px = 5;
  g.py = 17;
  g.lastAction = 'none';
  assert.equal(g.rotate(2), true, 'the 180 rotation should kick into place');
  g.hardDrop();
  if (g.clearAnim > 0) {
    g.clearAnim = 0;
    g.finishLock();
  }
  return g;
}

test('a 180 rotation into a notch registers a full T-spin double', () => {
  const g = playTsd();
  assert.equal(g.lastClear.tspin, true);
  assert.equal(g.lastClear.mini, false, 'kick 5 means a full T-spin');
  assert.equal(g.lastClear.kind, 'tspin-double');
  assert.equal(g.lastClear.lines, 2);
  assert.equal(g.lines, 2);
});

test('a T-spin double is worth 1200 points', () => {
  const g = playTsd();
  assert.equal(g.lastClear.points, 1200);
});

test('a T-spin double beats a plain double on score and garbage', () => {
  const g = playTsd();
  const base = { level: 1, perfect: false, b2b: false, combo: -1, dropCells: 0, hardCells: 0 };
  const plain = scoreClear({ ...base, kind: 'double', lines: 2 });
  const spin = scoreClear({ ...base, kind: 'tspin-double', lines: 2 });

  assert.ok(spin.points > plain.points);
  assert.ok(spin.garbage > plain.garbage);
  assert.equal(spin.garbage, 13, 'a T-spin double sends 13 lines');
});

test('hard dropping never counts as a T-spin', () => {
  const g = makeBoard();
  g.piece = 'T';
  g.rot = 2;
  g.px = 5;
  g.py = 17;
  // Claim a rotation happened, then hard drop instead of settling.
  g.lastAction = 'rotate';
  g.lastKickIndex = 4;
  g.hardDrop();
  if (g.clearAnim > 0) {
    g.clearAnim = 0;
    g.finishLock();
  }
  assert.equal(g.lastClear.tspin, false, 'a hard drop is not a T-spin');
});

test('sliding into the notch instead of rotating is not a T-spin', () => {
  const g = makeBoard();
  g.piece = 'T';
  g.rot = 0;
  g.px = 4;
  g.py = 18;
  g.lastAction = 'move';
  g.lastKickIndex = 4;
  g.lockPiece();
  if (g.clearAnim > 0) {
    g.clearAnim = 0;
    g.finishLock();
  }
  assert.equal(g.lastClear.tspin, false);
});

test('the last kick index separates a mini from a full T-spin', () => {
  const mini = makeBoard();
  mini.piece = 'T';
  mini.rot = 0;
  mini.px = 4;
  mini.py = 18;
  mini.lastAction = 'rotate';
  mini.lastKickIndex = 1; // an early kick
  mini.lockPiece();
  if (mini.clearAnim > 0) {
    mini.clearAnim = 0;
    mini.finishLock();
  }
  assert.equal(mini.lastClear.tspin, true);
  assert.equal(mini.lastClear.mini, true);
  assert.equal(mini.lastClear.kind, 'tspin-mini-single');
});

test('an open board produces no T-spins', () => {
  const g = new Game({ seed: 99 });
  g.piece = 'T';
  g.rot = 0;
  g.px = 4;
  g.py = 5;
  g.lastAction = 'rotate';
  g.lastKickIndex = 4;
  g.lockPiece();
  assert.equal(g.lastClear.tspin, false);
});

test('only the T piece can T-spin', () => {
  for (const type of ['I', 'J', 'L', 'O', 'S', 'Z']) {
    const g = makeBoard();
    g.piece = type;
    g.rot = 0;
    g.px = 4;
    g.py = 17;
    g.lastAction = 'rotate';
    g.lastKickIndex = 4;
    assert.equal(g.detectTSpin(type, 0, 4, 17, 0), null, `${type} must not T-spin`);
  }
});

test('a mini T-spin scores less than the full version', () => {
  const base = { level: 1, perfect: false, b2b: false, combo: -1, dropCells: 0, hardCells: 0 };
  const mini = scoreClear({ ...base, kind: 'tspin-mini-single', lines: 1 });
  const full = scoreClear({ ...base, kind: 'tspin-single', lines: 1 });
  assert.ok(full.points > mini.points);
  assert.ok(full.garbage > mini.garbage);
});

test('rotating a T against the floor with two corners filled is not a T-spin', () => {
  const g = new Game({ seed: 5 });
  for (let x = 0; x < COLS; x++) g.board[(ROWS - 1) * COLS + x] = 2;
  g.piece = 'T';
  g.rot = 0;
  g.px = 4;
  g.py = ROWS - 2;
  g.lastAction = 'rotate';
  g.lastKickIndex = 0;
  g.lockPiece();
  assert.equal(g.lastClear.tspin, false, 'two corners is not enough');
});