/**
 * The game simulation: one instance per player.
 *
 * This class is the single source of truth for gameplay. The client runs a
 * copy for prediction and the server runs the authoritative one. It has no
 * DOM and no timers; callers drive it with `tick(deltaMs)`, which keeps
 * replays, rollback and server-side simulation straightforward.
 */

import {
  COLS,
  ROWS,
  CELL_COUNT,
  PIECE_IDS,
  LOCK_DELAY_MS,
  MAX_LOCK_RESETS,
  ENTRY_DELAY_MS,
  LINE_CLEAR_ANIM_MS,
  SOFT_DROP_FACTOR,
  gravityForLevel,
} from './constants.js';
import { Bag } from './rng.js';
import { cellsFor, kicksFor, boxCorners } from './pieces.js';
import { scoreClear, linesForLevel, levelForLines } from './scoring.js';

/** Spawn positions are in "hidden" rows above the visible field. */
const SPAWN_X = { I: 3, J: 3, L: 3, O: 4, S: 3, T: 3, Z: 3 };

export class Game {
  constructor(options = {}) {
    this.seed = options.seed >>> 0;
    this.startingLevel = clampInt(options.startingLevel ?? 1, 1, 15);
    this.garbageMode = options.garbageMode ?? 'off'; // off | hold | versus
    this.garbageCap = options.garbageCap ?? 20;
    this.reset();
  }

  reset() {
    this.board = new Uint8Array(CELL_COUNT);
    this.bag = new Bag(this.seed);
    this.piece = null;
    this.rot = 0;
    this.px = 0;
    this.py = 0;

    this.hold = null;
    this.holdUsed = false;

    this.level = this.startingLevel;
    this.lines = 0;
    this.score = 0;
    this.pieces = 0;
    this.combo = -1;
    this.b2b = false;
    this.deaths = 0;

    this.stats = {
      singles: 0,
      doubles: 0,
      triples: 0,
      quads: 0,
      tspins: 0,
      perfects: 0,
      maxCombo: 0,
      holds: 0,
    };

    this.dead = false;
    this.over = false;
    this.startedAt = 0;
    this.elapsed = 0;

    this.gravityAcc = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.grounded = false;
    this.softDropping = false;
    this.softDropCells = 0; // cells soft-dropped on the current piece
    this.bufferedHardDrop = false;

    this.pendingGarbage = 0;
    this.clearAnim = 0; // ms remaining of a line-clear animation
    this.clearRows = [];
    this.entryTimer = ENTRY_DELAY_MS;

    this.lastAction = 'none'; // 'move' | 'rotate' | 'drop' -> T-spin detection
    this.lastKickIndex = 0;
    this.lastClear = null;
    this.events = []; // drained by the host each tick

    this.spawn();
  }

  // ---------------------------------------------------------------- pieces

  spawn(type = null) {
    const t = type || this.bag.next();
    this.piece = t;
    this.rot = 0;
    this.px = SPAWN_X[t] ?? 3;
    // Spawn flush with the top of the field, so the piece is fully visible
    // and any collision means a genuine top-out.
    this.py = 0;
    this.gravityAcc = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.grounded = false;
    this.softDropping = false;
    this.lastAction = 'none';
    this.lastKickIndex = 0;

    if (this.collides(t, 0, this.px, this.py)) {
      this.topOut();
      return;
    }
    this.emit('spawn', { type: t });
  }

  /** Absolute cells of the active piece. */
  activeCells(piece = this.piece, rot = this.rot, px = this.px, py = this.py) {
    if (!piece) return [];
    return cellsFor(piece, rot).map(([x, y]) => [px + x, py + y]);
  }

  /** True if the piece at this position overlaps a wall, floor, or block. */
  collides(piece, rot, px, py) {
    const cells = cellsFor(piece, rot);
    for (const [cx, cy] of cells) {
      const x = px + cx;
      const y = py + cy;
      if (x < 0 || x >= COLS || y >= ROWS) return true;
      if (y >= 0 && this.board[y * COLS + x]) return true;
    }
    return false;
  }

  /** Where the piece would land if dropped straight down. */
  ghostY() {
    if (!this.piece) return 0;
    let y = this.py;
    while (!this.collides(this.piece, this.rot, this.px, y + 1)) y++;
    return y;
  }

  // ------------------------------------------------------------- commands

  /**
   * Apply one player input. Returns true if anything changed, so the caller
   * can decide whether it is worth replicating over the network.
   *
   * @param {object} input
   * @param {number} [input.dx] -1 left, +1 right
   * @param {number} [input.rot] -1 CCW, +1 CW, 2 for a half turn
   * @param {boolean} [input.softDrop]
   * @param {boolean} [input.hardDrop]
   * @param {boolean} [input.hold]
   */
  input(input = {}) {
    if (this.dead || this.over) return false;
    // Ignore input during the line-clear animation but remember a hard drop.
    if (this.clearAnim > 0) {
      if (input.hardDrop) this.bufferedHardDrop = true;
      return false;
    }

    let acted = false;

    if (input.hold) acted = this.holdPiece() || acted;
    if (input.rot) acted = this.rotate(input.rot) || acted;
    if (input.dx) acted = this.move(input.dx) || acted;

    if (input.softDrop !== undefined) {
      const want = !!input.softDrop && !this.dead;
      if (want !== this.softDropping) {
        this.softDropping = want;
        // Soft drop divides the gravity interval by 20. Any time already
        // banked against the natural curve would be spent as a burst of
        // instant rows, so discard it when the interval changes.
        this.gravityAcc = 0;
      }
    }

    if (input.hardDrop) acted = this.hardDrop() || acted;
    return acted;
  }

  move(dx) {
    if (!this.piece) return false;
    if (this.collides(this.piece, this.rot, this.px + dx, this.py)) return false;
    this.px += dx;
    this.lastAction = 'move';
    this.onPieceMoved();
    return true;
  }

  /**
   * Rotate using SRS wall kicks. Tries each kick in order and takes the first
   * that lands legally. Records the winning kick for T-spin classification.
   */
  rotate(dir) {
    if (!this.piece || this.piece === 'O') {
      // O still counts as a rotate action for lastAction purposes.
      if (this.piece === 'O') {
        this.rot = (this.rot + 2) & 3;
        this.lastAction = 'rotate';
      }
      return false;
    }

    const from = this.rot;
    const to = (from + (dir === 2 ? 2 : dir === 1 ? 1 : 3)) & 3;
    const kicks = kicksFor(this.piece, from, to);

    for (let i = 0; i < kicks.length; i++) {
      const [kx, ky] = kicks[i];
      const nx = this.px + kx;
      const ny = this.py + ky;
      if (!this.collides(this.piece, to, nx, ny)) {
        this.px = nx;
        this.py = ny;
        this.rot = to;
        this.lastAction = 'rotate';
        this.lastKickIndex = i;
        this.onPieceMoved();
        return true;
      }
    }
    return false;
  }

  onPieceMoved() {
    // Lock delay resets when the piece is moved or rotated after landing.
    if (this.grounded && this.lockResets < MAX_LOCK_RESETS) {
      this.lockTimer = 0;
      this.lockResets++;
    }
  }

  holdPiece() {
    if (this.holdUsed || !this.piece) return false;
    const swap = this.hold;
    this.hold = this.piece;
    this.holdUsed = true;
    this.stats.holds++;
    this.spawn(swap || null);
    this.emit('hold', { piece: this.hold });
    return true;
  }

  hardDrop() {
    if (!this.piece) return false;
    const target = this.ghostY();
    const dist = target - this.py;
    this.py = target;
    this.emit('harddrop', { dist });
    this.lockPiece(dist);
    return true;
  }

  /** Merge the piece into the board and resolve any full rows. */
  lockPiece(dropDistance = 0) {
    const piece = this.piece;
    const rot = this.rot;
    const cells = this.activeCells();

    const tspin = this.detectTSpin(piece, rot, this.px, this.py, dropDistance);

    for (const [x, y] of cells) {
      if (y < 0) continue; // above the field, discard
      this.board[y * COLS + x] = PIECE_IDS[piece];
    }

    this.pieces++;
    const full = this.findFullRows();

    let kind = 'none';
    if (tspin) {
      if (tspin.mini) kind = full.length === 0 ? 'tspin-mini' : 'tspin-mini-single';
      else kind = ['none', 'tspin-single', 'tspin-double', 'tspin-triple'][full.length] || 'tspin';
    } else {
      kind = ['none', 'single', 'double', 'triple', 'quad'][full.length] || 'none';
    }

    const perfect = full.length > 0 && this.countFilled() === full.length * COLS;
    const result = scoreClear({
      kind,
      lines: full.length,
      level: this.level,
      perfect,
      b2b: this.b2b,
      combo: this.combo,
      dropCells: this.softDropCells,
      hardCells: dropDistance,
    });

    this.score += result.points;
    if (full.length > 0) {
      this.combo++;
      this.stats.maxCombo = Math.max(this.stats.maxCombo, this.combo);
      this.lines += full.length;
      this.updateLevel();
      this.emit('garbage', { lines: result.garbage, from: piece });
      this.pendingAttack = (this.pendingAttack || 0) + result.garbage;
    } else {
      this.combo = -1;
    }
    this.b2b = result.b2b;

    this.trackStat(kind, full.length, perfect);

    this.lastClear = {
      kind,
      lines: full.length,
      points: result.points,
      combo: this.combo,
      b2b: result.b2b,
      tspin: !!tspin,
      mini: !!(tspin && tspin.mini),
      perfect,
      at: this.elapsed,
    };
    if (full.length > 0 || result.points > 0) this.emit('clear', { ...this.lastClear });

    // Animate, then collapse the rows.
    this.clearRows = full;
    this.clearAnim = full.length > 0 ? LINE_CLEAR_ANIM_MS : 0;
    if (full.length === 0) {
      this.finishLock();
    }
    return result;
  }

  trackStat(kind, lines, perfect) {
    if (kind === 'single') this.stats.singles++;
    else if (kind === 'double') this.stats.doubles++;
    else if (kind === 'triple') this.stats.triples++;
    else if (kind === 'quad') this.stats.quads++;
    if (kind.startsWith('tspin') && lines > 0) this.stats.tspins++;
    if (perfect) this.stats.perfects++;
  }

  /** Called once a clear animation ends, or immediately on a quiet lock. */
  finishLock() {
    if (this.clearRows.length > 0) {
      this.collapseRows(this.clearRows);
      this.clearRows = [];
    }
    this.softDropCells = 0;
    this.piece = null;
    if (!this.dead && !this.over) this.spawn();
  }

  collapseRows(rows) {
    const sorted = rows.slice().sort((a, b) => a - b);
    let write = ROWS - 1;
    for (let y = ROWS - 1; y >= 0; y--) {
      if (sorted.includes(y)) continue;
      for (let x = 0; x < COLS; x++) {
        this.board[write * COLS + x] = this.board[y * COLS + x];
      }
      write--;
    }
    while (write >= 0) {
      for (let x = 0; x < COLS; x++) this.board[write * COLS + x] = 0;
      write--;
    }
  }

  findFullRows() {
    const rows = [];
    for (let y = 0; y < ROWS; y++) {
      let full = true;
      for (let x = 0; x < COLS; x++) {
        if (!this.board[y * COLS + x]) {
          full = false;
          break;
        }
      }
      if (full) rows.push(y);
    }
    return rows;
  }

  countFilled() {
    let n = 0;
    for (let i = 0; i < CELL_COUNT; i++) if (this.board[i]) n++;
    return n;
  }

  updateLevel() {
    const target = levelForLines(this.lines);
    if (target > this.level) {
      this.level = target;
      this.emit('levelup', { level: this.level });
    }
  }

  /**
   * T-spin test. Needs the last action to be a rotation, three of the four
   * corners of the piece's box to be occupied, and the piece to be settled
   * into a tight spot. Uses the last kick to tell a full spin from a mini.
   */
  detectTSpin(type, rot, px, py, dropDistance) {
    if (type !== 'T') return null;
    if (this.lastAction !== 'rotate') return null;
    if (dropDistance > 0) return null; // a hard drop is never a T-spin

    let occupied = 0;
    for (const [cx, cy] of boxCorners('T')) {
      const x = px + cx;
      const y = py + cy;
      const filled = x < 0 || x >= COLS || y >= ROWS || (y >= 0 && this.board[y * COLS + x]);
      if (filled) occupied++;
    }
    if (occupied < 3) return null;

    // Kick index 4 is the "double kick" that always means a full T-spin.
    const mini = this.lastKickIndex < 4;
    return { mini };
  }

  // -------------------------------------------------------------- garbage

  /**
   * Push garbage rows in from the opponent side. Each row has one hole,
   * placed away from the edges so it is always survivable.
   */
  addGarbage(count) {
    if (count <= 0 || this.dead || this.over) return;
    const n = Math.min(count, this.garbageCap);
    this.pendingGarbage += n;
    this.emit('incoming', { count: n });
  }

  /** Splice the queued garbage into the board. */
  applyGarbage(count) {
    const rows = Math.min(count, ROWS);
    for (let i = 0; i < rows; i++) {
      const hole = 1 + (this.bag.rng.int(COLS - 2));
      const y = i; // grow upward from the bottom
      const target = ROWS - 1 - i;
      for (let x = 0; x < COLS; x++) {
        const from = target - 1;
        this.board[target * COLS + x] = from >= 0 ? this.board[from * COLS + x] : 0;
      }
      for (let x = 0; x < COLS; x++) {
        this.board[y * COLS + x] = x === hole ? 0 : 8; // 8 marks garbage
      }
    }
    this.pendingGarbage = Math.max(0, this.pendingGarbage - rows);

    // If the stack now reaches the ceiling, it is game over.
    if (this.countBlockedTop() >= 4) this.topOut();
  }

  countBlockedTop() {
    let n = 0;
    for (let x = 0; x < COLS; x++) {
      if (this.board[x] || this.board[COLS + x]) n++;
    }
    return n;
  }

  // ----------------------------------------------------------------- tick

  /**
   * Advance the simulation by deltaMs. Gravity, soft drop, and the lock delay
   * are all handled here so behaviour is identical on any frame rate.
   */
  tick(deltaMs) {
    if (this.dead) return;
    this.elapsed += deltaMs;
    this.lastDelta = deltaMs;

    if (this.over) return;

    if (this.clearAnim > 0) {
      this.clearAnim -= deltaMs;
      if (this.clearAnim <= 0) {
        this.clearAnim = 0;
        this.finishLock();
        if (this.bufferedHardDrop && this.piece && !this.dead) {
          this.bufferedHardDrop = false;
          this.hardDrop();
        }
        this.bufferedHardDrop = false;
      }
      return;
    }

    // Hold lock until the spawn has slid in.
    if (this.entryTimer > 0) {
      this.entryTimer -= deltaMs;
      if (this.entryTimer <= 0) this.entryTimer = 0;
    }
    if (this.entryTimer > 0 || !this.piece) return;

    const g = gravityForLevel(this.level) * 1000;
    const step = this.softDropping ? g / SOFT_DROP_FACTOR : g;
    this.gravityAcc += deltaMs;

    let steps = 0;
    while (this.gravityAcc >= step && steps < ROWS) {
      this.gravityAcc -= step;
      steps++;
      if (!this.collides(this.piece, this.rot, this.px, this.py + 1)) {
        this.py++;
        // Only soft-dropped cells score; natural gravity is free.
        if (this.softDropping) this.softDropCells++;
        this.grounded = false;
        this.lockTimer = 0;
      } else {
        this.grounded = true;
        break;
      }
    }
    if (this.gravityAcc > 1000) this.gravityAcc = 0; // avoid a spiral of death

    // Lock delay.
    if (this.grounded) {
      this.lockTimer += deltaMs;
      if (this.lockTimer >= LOCK_DELAY_MS) {
        this.lockPiece();
      }
    } else {
      this.lockTimer = 0;
    }

    // Feed pending garbage in one row at a time so it animates in.
    if (this.pendingGarbage > 0) {
      this.garbageTimer = (this.garbageTimer || 0) + deltaMs;
      const perRow = 100;
      while (this.garbageTimer >= perRow && this.pendingGarbage > 0) {
        this.garbageTimer -= perRow;
        this.applyGarbage(1);
        if (this.dead) break;
      }
    }
  }

  topOut() {
    if (this.dead) return;
    this.dead = true;
    this.piece = null;
    this.deaths++;
    this.emit('topout', { score: this.score, lines: this.lines });
  }

  /**
   * Serialize for the network. Small on purpose: this goes out 20 times a
   * second, so the 200-cell board is packed into a short string.
   *
   * `full` includes the complete piece queue, which a client needs only when it
   * is about to adopt this snapshot as its new baseline. `stats` includes the
   * end-of-match counters.
   */
  snapshot({ full = false, stats = false } = {}) {
    const snap = {
      b: encodeBoard(this.board),
      p: this.piece,
      r: this.rot,
      x: this.px,
      y: this.py,
      h: this.hold,
      n: this.bag.peek(5),
      // Only the preview is sent normally; a client that adopts a snapshot
      // needs the whole queue, so that is requested with { full: true }.
      ...(full ? { q: this.bag.queue.slice() } : {}),
      s: this.score,
      l: this.lines,
      lv: this.level,
      c: this.combo,
      b2: this.b2b,
      d: this.dead ? 1 : 0,
      pg: this.pendingGarbage,
      ca: Math.round(this.clearAnim),
      cr: this.clearRows,
      t: Math.round(this.elapsed),
    };
    if (stats) snap.st = this.stats;
    return snap;
  }

  emit(type, data) {
    this.events.push({ type, data });
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }
}

// --------------------------------------------------------------- helpers

function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.floor(Number(v) || lo)));
}

/**
 * Board -> base-ish string. Values are 0-8, so a single character per cell is
 * enough and 200 cells turns into a 200 byte string.
 */
export function encodeBoard(board) {
  let out = '';
  for (let i = 0; i < board.length; i++) {
    const v = board[i] === 8 ? 'g' : String(board[i]);
    out += v;
  }
  return out;
}

export function decodeBoard(str, target) {
  const board = target || new Uint8Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i++) {
    const ch = str.charCodeAt(i);
    board[i] = ch === 103 ? 8 : ch - 48; // 'g' = 103
  }
  return board;
}

export { linesForLevel, levelForLines };