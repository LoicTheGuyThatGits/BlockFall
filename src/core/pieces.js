/**
 * Piece geometry and Super Rotation System (SRS) wall kicks.
 *
 * Every piece is stored as 4 rotation states. Each state is a list of cell
 * offsets inside a small bounding box, so a piece is positioned by the
 * top-left of that box plus a rotation index.
 *
 * Offsets are [x, y] with y growing downward, matching the board array.
 * Spawn orientation is rotation 0.
 */

/** Bounding box size per piece, used for T-spin corner checks and rendering. */
export const BOX_SIZE = { I: 4, O: 2, J: 3, L: 3, S: 3, T: 3, Z: 3 };

/**
 * Rotation states, hand-written from the standard SRS layouts.
 * J: ####. ##.. #... .##. .##. .#.. .#.. #... .##.
 */
const STATES = {
  I: [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
    [[0, 2], [1, 2], [2, 2], [3, 2]],
    [[1, 0], [1, 1], [1, 2], [1, 3]],
  ],
  J: [
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [1, 1], [0, 2], [1, 2]],
  ],
  L: [
    [[2, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 1], [1, 1], [2, 1], [0, 2]],
    [[0, 0], [1, 0], [1, 1], [1, 2]],
  ],
  O: [
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[0, 0], [1, 0], [0, 1], [1, 1]],
  ],
  S: [
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
    [[1, 1], [2, 1], [0, 2], [1, 2]],
    [[0, 0], [0, 1], [1, 1], [1, 2]],
  ],
  T: [
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [1, 2]],
    [[1, 0], [0, 1], [1, 1], [1, 2]],
  ],
  Z: [
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[2, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [1, 2], [2, 2]],
    [[1, 0], [0, 1], [1, 1], [0, 2]],
  ],
};

/** Cell offsets for a piece at a rotation index, cloned so callers can mutate. */
export function cellsFor(type, rot) {
  return STATES[type][rot & 3].map((c) => [c[0], c[1]]);
}

/**
 * SRS kick tables. Keyed by `${from}${to}` where 0 = spawn, 1 = right (CW),
 * 2 = 180, 3 = left (CCW). Values are the offsets tried in order; the first
 * one that lands the piece in a legal spot wins.
 *
 * The classic tables are for 0->1, 1->2, 2->3, 3->0 (CW) and their mirrors.
 * We only need one direction's worth and reverse it for CCW.
 */
const KICKS_JLSTZ = {
  '01': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '10': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '12': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '21': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '23': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '32': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '30': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '03': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};

const KICKS_I = {
  '01': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '10': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '12': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '21': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '23': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '32': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '30': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '03': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

/** O never kicks, it just rotates in place. */
const KICKS_O = {};

/** 180 kicks are not in the guideline; these make the spin feel natural. */
const KICKS_180_JLSTZ = [[0, 0], [0, -1], [1, 0], [-1, 0], [0, 1], [1, -1], [-1, 1]];
const KICKS_180_I = [[0, 0], [-1, 0], [-2, 0], [1, 0], [2, 0], [0, 1], [0, -1]];

/** Returns the list of candidate offsets for a rotation transition. */
export function kicksFor(type, from, to) {
  if (type === 'O') return KICKS_O;
  const table = type === 'I' ? KICKS_I : KICKS_JLSTZ;
  const key = `${from}${to}`;
  if (table[key]) return table[key];

  // 180 spin: from 0 -> 2 or 2 -> 0.
  if ((from === 0 && to === 2) || (from === 2 && to === 0)) {
    return type === 'I' ? KICKS_180_I : KICKS_180_JLSTZ;
  }
  if ((from === 1 && to === 3) || (from === 3 && to === 1)) {
    const flips = (list) => list.map(([x, y]) => [-x, y]);
    const base = type === 'I' ? KICKS_180_I : KICKS_180_JLSTZ;
    return from === 1 ? flips(base) : base;
  }
  return [[0, 0]];
}

/**
 * The four corner offsets of a piece's bounding box, used for the T-spin
 * corner check.
 */
export function boxCorners(type) {
  const box = BOX_SIZE[type];
  return [
    [0, 0],
    [box - 1, 0],
    [0, box - 1],
    [box - 1, box - 1],
  ];
}