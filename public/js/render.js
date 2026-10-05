/**
 * Canvas rendering: playfield, hold, next, and opponent mini-boards.
 *
 * The renderer takes a game snapshot (plain data from the server) plus the
 * local predicted game, and paints a frame. It never mutates game state.
 */

import { COLS, ROWS, PIECE_COLORS, LINE_CLEAR_ANIM_MS } from '../../src/core/constants.js';
import { cellsFor } from '../../src/core/pieces.js';
import { SpriteCache } from './sprites.js';

export class Renderer {
  constructor(boardCanvas, holdCanvas, nextCanvas) {
    this.win = window;
    this.board = boardCanvas;
    this.hold = holdCanvas;
    this.next = nextCanvas;
    this.bctx = boardCanvas.getContext('2d');
    this.hctx = holdCanvas.getContext('2d');
    this.nctx = nextCanvas.getContext('2d');
    this.cell = 32;
    this.flash = 0;
    this.shake = 0;
    this.doc = this.win.document;
    this.dpr = Math.min(this.win.devicePixelRatio || 1, 2);
    this.sprites = new SpriteCache(this.doc);
    this.layout();
    this.win.addEventListener('resize', () => this.layout());
  }

  /**
   * Pick a cell size that fits the viewport and rebuild sprites if it moved.
   * Caps the board height so the hold/next columns always have room.
   */
  layout() {
    const vw = this.win.innerWidth;
    const vh = this.win.innerHeight;
    const isNarrow = vw < 760;

    // Leave room for the HUD columns on wide screens.
    const maxW = isNarrow ? vw * 0.86 : Math.min(vw * 0.42, 420);
    const maxH = vh * (isNarrow ? 0.62 : 0.88);
    let cell = Math.floor(Math.min(maxW / COLS, maxH / ROWS));
    cell = Math.max(18, Math.min(44, cell));

    this.cell = cell;
    this.set = this.sprites.at(cell);

    const w = cell * COLS;
    const h = cell * ROWS;
    this.board.style.width = `${w}px`;
    this.board.style.height = `${h}px`;
    this.resizeCanvas(this.board, w, h);

    // Hold and next are drawn at a fraction of the board cell size.
    const small = Math.max(11, Math.floor(cell * 0.34));
    this.smallCell = small;
    this.smallSet = this.sprites.at(small);

    this.hold.style.width = `${small * 4.5}px`;
    this.hold.style.height = `${small * 3.6}px`;
    this.resizeCanvas(this.hold, small * 4.5, small * 3.6);

    this.next.style.width = `${small * 4.5}px`;
    this.next.style.height = `${small * 11}px`;
    this.resizeCanvas(this.next, small * 4.5, small * 11);
  }

  resizeCanvas(canvas, cssW, cssH) {
    const dpr = this.dpr;
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  /**
   * Draw one frame of the main board.
   * @param {object} g - a Game instance (local prediction or server mirror)
   */
  drawBoard(g) {
    const ctx = this.bctx;
    const cell = this.cell;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cell * COLS, cell * ROWS);

    // Screen shake on big clears and incoming garbage.
    if (this.shake > 0) {
      this.shake--;
      const mag = (this.shake / 6) * cell * 0.35;
      ctx.translate((Math.random() - 0.5) * mag, (Math.random() - 0.5) * mag);
    }

    // Board background grid.
    ctx.drawImage(this.set.grid, 0, 0, cell * COLS, cell * ROWS);

    // Settled blocks.
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const v = g.board[y * COLS + x];
        if (!v) continue;
        const img = v === 8 ? this.set.garbage : this.set.blocks[pieceNameForId(v)];
        ctx.drawImage(img, x * cell, y * cell, cell, cell);
      }
    }

    // Ghost piece.
    if (g.piece && !g.dead) {
      const gy = g.ghostY();
      const cells = cellsFor(g.piece, g.rot);
      for (const [dx, dy] of cells) {
        const x = g.px + dx;
        const y = gy + dy;
        if (y < 0) continue;
        ctx.drawImage(this.set.ghosts[g.piece], x * cell, y * cell, cell, cell);
      }
    }

    // Active piece with a soft glow behind it.
    if (g.piece && !g.dead) {
      const cells = cellsFor(g.piece, g.rot);
      const xs = cells.map((c) => g.px + c[0]);
      const ys = cells.map((c) => g.py + c[1]);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      if (maxY >= 0 && minY < ROWS) {
        ctx.globalAlpha = 0.5;
        ctx.drawImage(
          this.set.glows[g.piece],
          minX * cell - cell * 0.5,
          Math.max(0, minY) * cell - cell * 0.5,
          (maxX - minX + 2) * cell,
          (maxY - Math.max(0, minY) + 2) * cell
        );
        ctx.globalAlpha = 1;
      }
      for (const [dx, dy] of cells) {
        const x = g.px + dx;
        const y = g.py + dy;
        if (y < 0) continue;
        ctx.drawImage(this.set.blocks[g.piece], x * cell, y * cell, cell, cell);
      }
    }

    // Line-clear flash.
    if (g.clearRows && g.clearRows.length && g.clearAnim > 0) {
      const t = 1 - g.clearAnim / LINE_CLEAR_ANIM_MS;
      const alpha = 1 - t;
      for (const y of g.clearRows) {
        ctx.fillStyle = `rgba(255,255,255,${alpha * 0.75})`;
        ctx.fillRect(0, y * cell, cell * COLS, cell);
      }
    }

    // Danger line: red glow near the top when the stack is high.
    const topRow = highestFilled(g);
    if (topRow <= 3) {
      const a = 0.1 + (3 - topRow) * 0.08;
      const grad = ctx.createLinearGradient(0, 0, 0, cell * 5);
      grad.addColorStop(0, `rgba(239,68,68,${a})`);
      grad.addColorStop(1, 'rgba(239,68,68,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, cell * COLS, cell * 5);
    }

    if (g.dead) {
      ctx.fillStyle = 'rgba(15,23,42,0.55)';
      ctx.fillRect(0, 0, cell * COLS, cell * ROWS);
    }
  }

  drawHold(type) {
    const ctx = this.hctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const w = this.smallCell * 4.5;
    const h = this.smallCell * 3.6;
    ctx.clearRect(0, 0, w, h);
    if (!type) return;
    this.drawMiniPiece(ctx, type, w / 2, h / 2, this.smallCell);
  }

  drawNext(list) {
    const ctx = this.nctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const cell = this.smallCell;
    const w = cell * 4.5;
    const h = cell * 11;
    ctx.clearRect(0, 0, w, h);
    const per = h / Math.max(1, list.length);
    list.forEach((type, i) => {
      // The first preview is full size, the rest step down.
      const scale = i === 0 ? 1 : 0.82 - i * 0.03;
      this.drawMiniPiece(ctx, type, w / 2, per * (i + 0.5), cell * scale);
    });
  }

  /** Centre a piece's spawn shape on a point and draw its four blocks. */
  drawMiniPiece(ctx, type, cx, cy, cell) {
    const cells = cellsFor(type, 0);
    const xs = cells.map((c) => c[0]);
    const ys = cells.map((c) => c[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const ox = cx - ((maxX - minX + 1) * cell) / 2 - minX * cell;
    const oy = cy - ((maxY - minY + 1) * cell) / 2 - minY * cell;
    const img = this.sprites.at(Math.round(cell)).blocks[type];
    for (const [dx, dy] of cells) {
      ctx.drawImage(img, ox + dx * cell, oy + dy * cell, cell, cell);
    }
  }

  /** Small read-only board for the opponents list. */
  drawMiniBoard(canvas, snap, cell = 8) {
    const ctx = canvas.getContext('2d');
    const dpr = this.dpr;
    const w = cell * COLS;
    const h = cell * ROWS;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(15,23,42,0.5)';
    ctx.fillRect(0, 0, w, h);
    if (!snap || !snap.b) return;

    const board = decodeBoardString(snap.b);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const v = board[y * COLS + x];
        if (!v) continue;
        ctx.fillStyle = v === 8 ? PIECE_COLORS.garbage : PIECE_COLORS[pieceNameForId(v)];
        ctx.fillRect(x * cell, y * cell, cell - 1, cell - 1);
      }
    }
    if (snap.p && !snap.d) {
      const cells = cellsFor(snap.p, snap.r);
      for (const [dx, dy] of cells) {
        const x = snap.x + dx;
        const y = snap.y + dy;
        if (y < 0) continue;
        ctx.fillStyle = PIECE_COLORS[snap.p];
        ctx.fillRect(x * cell, y * cell, cell - 1, cell - 1);
      }
    }
    if (snap.cr && snap.cr.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      for (const y of snap.cr) ctx.fillRect(0, y * cell, w, cell - 1);
    }
  }
}

function pieceNameForId(id) {
  return { 1: 'I', 2: 'J', 3: 'L', 4: 'O', 5: 'S', 6: 'T', 7: 'Z' }[id] || 'I';
}

/** Turn a snapshot board string back into a typed array. */
function decodeBoardString(str) {
  const out = new Uint8Array(COLS * ROWS);
  for (let i = 0; i < out.length; i++) {
    const code = str.charCodeAt(i);
    out[i] = code === 103 ? 8 : code - 48;
  }
  return out;
}

function highestFilled(g) {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (g.board[y * COLS + x]) return y;
    }
  }
  return ROWS;
}