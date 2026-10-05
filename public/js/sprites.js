/**
 * Sprite generation.
 *
 * There are no image files in this project. Every sprite is drawn to an
 * offscreen canvas at boot and cached here, which keeps the repo tiny and
 * means blocks stay crisp on any screen density.
 *
 * The owning document is passed in rather than read off the global, so each
 * client instance owns the canvases it draws.
 */

import { PIECE_COLORS } from '../../src/core/constants.js';

/* --------------------------------------------------------------- helpers */

/** An offscreen drawing surface. */
function surface(doc, w, h) {
  const c = doc.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Shift a hex colour toward white (t > 0) or black (t < 0). */
function shade(hex, t) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    t >= 0 ? Math.round(v + (255 - v) * t) : Math.round(v * (1 + t))
  );
  return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
}

/** Same colour with an alpha channel, for glows and overlays. */
function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* --------------------------------------------------------------- blocks */

/**
 * One block tile: a bevelled face with a highlight along the top-left edge and
 * a shadow along the bottom-right, which reads as a solid cube at small sizes.
 *
 * With `ghost`, only a translucent outline is drawn, used for the drop preview.
 */
export function blockSprite(doc, hex, size = 32, opts = {}) {
  const { ghost = false } = opts;
  const c = surface(doc, size, size);
  const ctx = c.getContext('2d');
  const pad = Math.max(1, Math.round(size * 0.06));
  const w = size - pad * 2;
  const r = Math.max(2, Math.round(size * 0.14));

  if (ghost) {
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = hex;
    ctx.lineWidth = Math.max(1.5, size * 0.09);
    roundRect(ctx, pad + 1, pad + 1, w - 2, w - 2, r);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return c;
  }

  const grad = ctx.createLinearGradient(pad, pad, pad + w, pad + w);
  grad.addColorStop(0, shade(hex, 0.28));
  grad.addColorStop(0.5, hex);
  grad.addColorStop(1, shade(hex, -0.3));
  ctx.fillStyle = grad;
  roundRect(ctx, pad, pad, w, w, r);
  ctx.fill();

  // Top-left highlight.
  ctx.strokeStyle = shade(hex, 0.55);
  ctx.lineWidth = Math.max(1, size * 0.055);
  ctx.beginPath();
  ctx.moveTo(pad + r, pad + ctx.lineWidth);
  ctx.lineTo(pad + w - r, pad + ctx.lineWidth);
  ctx.stroke();

  // Bottom-right shadow.
  ctx.strokeStyle = shade(hex, -0.45);
  ctx.beginPath();
  ctx.moveTo(pad + ctx.lineWidth, pad + w - r);
  ctx.lineTo(pad + w - ctx.lineWidth, pad + w - r);
  ctx.stroke();

  // Specular dot.
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.arc(pad + w * 0.28, pad + w * 0.26, size * 0.075, 0, Math.PI * 2);
  ctx.fill();

  return c;
}

/** Garbage rows are hatched grey so they never look like your own pieces. */
export function garbageSprite(doc, size = 32) {
  const c = blockSprite(doc, PIECE_COLORS.garbage, size);
  const ctx = c.getContext('2d');
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = 'rgba(15,23,42,0.85)';
  ctx.lineWidth = Math.max(1, size * 0.06);
  const pad = Math.max(1, Math.round(size * 0.06));
  const span = size - pad * 2;
  for (let i = -span; i < span; i += size * 0.22) {
    ctx.beginPath();
    ctx.moveTo(pad + i, pad + span);
    ctx.lineTo(pad + i + span, pad);
    ctx.stroke();
  }
  ctx.restore();
  return c;
}

/** Soft glow blob drawn behind the active piece. */
export function glowSprite(doc, hex, size = 64) {
  const c = surface(doc, size, size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, withAlpha(hex, 0.55));
  g.addColorStop(0.5, withAlpha(hex, 0.18));
  g.addColorStop(1, withAlpha(hex, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/* ----------------------------------------------------------------- grid */

/** Faint cell grid used as the playfield background. */
export function gridSprite(doc, cell = 32, cols = 10, rows = 20) {
  const c = surface(doc, cell * cols, cell * rows);
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(148,163,184,0.055)';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      ctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
    }
  }
  ctx.strokeStyle = 'rgba(148,163,184,0.09)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= cols; x++) {
    ctx.beginPath();
    ctx.moveTo(x * cell + 0.5, 0);
    ctx.lineTo(x * cell + 0.5, cell * rows);
    ctx.stroke();
  }
  for (let y = 0; y <= rows; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * cell + 0.5);
    ctx.lineTo(cell * cols, y * cell + 0.5);
    ctx.stroke();
  }
  return c;
}

/* --------------------------------------------------------------- cache */

/**
 * Builds every sprite at a given cell size and holds onto them. Rebuilt when
 * the layout picks a different cell size, so no network requests are needed.
 */
export class SpriteCache {
  constructor(doc) {
    this.doc = doc;
    /** One full sprite set per cell size, built on first use. */
    this.sets = new Map();
  }

  /** Build (or reuse) the sprite set for a cell size. */
  at(cell) {
    const key = Math.round(cell);
    let set = this.sets.get(key);
    if (set) return set;

    set = { blocks: {}, ghosts: {}, glows: {} };
    for (const [type, hex] of Object.entries(PIECE_COLORS)) {
      if (type === 'garbage') continue;
      set.blocks[type] = blockSprite(this.doc, hex, key);
      set.ghosts[type] = blockSprite(this.doc, hex, key, { ghost: true });
      set.glows[type] = glowSprite(this.doc, hex, key * 2);
    }
    set.garbage = garbageSprite(this.doc, key);
    set.garbageGhost = blockSprite(this.doc, PIECE_COLORS.garbage, key, { ghost: true });
    set.grid = gridSprite(this.doc, key);

    // Only a handful of sizes ever get used, so an unbounded map is fine, but
    // drop everything if it somehow grows.
    if (this.sets.size > 8) this.sets.clear();
    this.sets.set(key, set);
    return set;
  }
}