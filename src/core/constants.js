/**
 * Shared, framework-free constants for the Blockfall engine.
 * Imported by both the browser client and the Node server, so it must stay
 * free of any DOM or Node-specific APIs.
 */

export const COLS = 10;
export const ROWS = 20;
export const CELL_COUNT = COLS * ROWS;

/** Piece ids as stored inside the board array. 0 means empty. */
export const PIECE_IDS = { I: 1, J: 2, L: 3, O: 4, S: 5, T: 6, Z: 7 };
export const PIECE_LIST = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];

/** CSS colours, kept here so the server can hand them to clients for theming. */
export const PIECE_COLORS = {
  I: '#22d3ee',
  J: '#3b82f6',
  L: '#f97316',
  O: '#facc15',
  S: '#22c55e',
  T: '#a855f7',
  Z: '#ef4444',
  garbage: '#64748b',
};

export const LOCK_DELAY_MS = 500;
/** How many times a piece may be nudged to reset the lock delay. */
export const MAX_LOCK_RESETS = 15;
/** Grace period before a freshly spawned piece starts falling. */
export const ENTRY_DELAY_MS = 0;
/** How long cleared rows flash before the stack collapses. */
export const LINE_CLEAR_ANIM_MS = 260;

/**
 * Seconds per row of natural gravity at a given level.
 * The classic formula: (0.8 - (level-1) * 0.007) ^ (level-1)
 */
export function gravityForLevel(level) {
  const l = Math.max(1, Math.min(level, 20));
  return Math.pow(0.8 - (l - 1) * 0.007, l - 1);
}

/** Soft drop divides the level curve by this factor for extra speed. */
export const SOFT_DROP_FACTOR = 20;