/**
 * Scoring and garbage (attack) tables.
 *
 * Line-clear values follow the Tetris Guideline, including back-to-back and
 * combo bonuses. Garbage values are the common competitive-community numbers,
 * kept separate so they can be tuned without touching the score math.
 */

/**
 * Points for a clear, before level, combo and back-to-back multipliers.
 * Keyed by clear kind; `perfect_*` keys are used when the board is emptied.
 */
const LINE_SCORES = {
  none: 0,
  single: 100,
  double: 300,
  triple: 500,
  quad: 800,
  tspin: 400,
  'tspin-single': 800,
  'tspin-double': 1200,
  'tspin-triple': 1600,
  'tspin-mini': 100,
  'tspin-mini-single': 200,
  perfect_single: 800,
  perfect_double: 1200,
  perfect_triple: 1800,
  perfect_quad: 2000,
};

/**
 * Garbage lines sent to each opponent for a clear.
 * Quad and T-spins are the real weapons here.
 */
const ATTACK_TABLE = {
  single: 0,
  double: 1,
  triple: 2,
  quad: 4,
  tspin: 4,
  'tspin-single': 8,
  'tspin-double': 13,
  'tspin-triple': 18,
  'tspin-mini': 0,
  'tspin-mini-single': 2,
  perfect_single: 0,
  perfect_double: 2,
  perfect_triple: 4,
  perfect_quad: 8,
};

/**
 * Clears that count as "difficult" for back-to-back purposes.
 * Chaining two of these keeps the multiplier alive.
 */
const DIFFICULT_CLEARS = new Set([
  'quad',
  'tspin',
  'tspin-single',
  'tspin-double',
  'tspin-triple',
  'tspin-mini-single',
  'perfect_double',
  'perfect_triple',
  'perfect_quad',
]);

/** Bonus for each consecutive clear in a combo. */
const COMBO_POINTS = 50;
/** Applied to score and garbage while a back-to-back chain is alive. */
const B2B_MULTIPLIER = 1.5;

/**
 * Works out the final score for a lock.
 *
 * @param {object} clear
 * @param {string} clear.kind        e.g. 'quad', 'tspin-single', 'single'
 * @param {number} clear.lines      rows cleared
 * @param {number} clear.level      current level
 * @param {boolean} clear.perfect   board emptied completely
 * @param {boolean} clear.b2b       chains off a previous difficult clear
 * @param {number} clear.combo      consecutive clears before this one (-1 = none)
 * @param {number} clear.dropCells  cells soft-dropped (1 pt each)
 * @param {number} clear.hardCells  cells hard-dropped (2 pts each)
 * @returns {{points: number, garbage: number, b2b: boolean, combo: number}}
 */
export function scoreClear(clear) {
  const { kind, lines, level, perfect, combo, dropCells, hardCells } = clear;

  let base = LINE_SCORES[kind] ?? 0;
  if (perfect && lines > 0) {
    const pk = `perfect_${['', 'single', 'double', 'triple', 'quad'][lines]}`;
    base = LINE_SCORES[pk] ?? base;
  }

  // Combo adds 50 x combo on top of the clear itself.
  let points = base;
  if (lines > 0 && combo > 0) points += COMBO_POINTS * combo;

  const difficult = DIFFICULT_CLEARS.has(kind) || (perfect && lines > 0);
  let b2b = false;
  if (lines > 0 && difficult && clear.b2b) {
    points = Math.floor(points * B2B_MULTIPLIER);
    b2b = true;
  }

  points = Math.floor(points * Math.max(1, level));
  points += dropCells + hardCells * 2;

  // Garbage scales the same way: base attack, combo bonus, b2b multiplier.
  let garbage = ATTACK_TABLE[kind] ?? 0;
  if (perfect && lines > 0) {
    garbage = ATTACK_TABLE[`perfect_${['', 'single', 'double', 'triple', 'quad'][lines]}`] ?? garbage;
  }
  if (lines > 0 && combo > 0) garbage += Math.floor(combo / 2);
  if (lines > 0 && difficult && clear.b2b) {
    garbage = Math.floor(garbage * B2B_MULTIPLIER);
  }

  return { points, garbage, b2b, difficult };
}

/** How many rows to add for a given level, per standard level-up curves. */
export function linesForLevel(level) {
  if (level <= 1) return 0;
  if (level <= 10) return level * 2 - 2;
  return 8 * level - 30;
}

/** Level needed to reach a line count, for choosing a starting level. */
export function levelForLines(lines) {
  let level = 1;
  while (level < 30 && linesForLevel(level + 1) <= lines) level++;
  return level;
}