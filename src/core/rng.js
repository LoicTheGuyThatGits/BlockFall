/**
 * Deterministic RNG + 7-bag randomizer.
 *
 * The server and every client must derive the exact same piece sequence from
 * the same seed, so this uses a small integer hash instead of Math.random.
 */

/** mulberry32 - fast, tiny, and good enough for a piece queue. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (n) => Math.floor(rng() * n);
  /** Expose/restore internal state so a game can be serialised mid-match. */
  rng.getState = () => a;
  rng.setState = (s) => {
    a = s >>> 0;
  };
  return rng;
}

const PIECE_LIST = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];

/**
 * 7-bag randomizer. Hands out pieces in shuffled groups of seven so a long
 * drought of the same piece is impossible.
 */
export class Bag {
  constructor(seed) {
    this.rng = makeRng(seed);
    this.queue = [];
    this.refill();
    this.refill();
  }

  refill() {
    const bag = PIECE_LIST.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = this.rng.int(i + 1);
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    this.queue.push(...bag);
  }

  /** Take the next piece off the queue. */
  next() {
    if (this.queue.length <= 7) this.refill();
    return this.queue.shift();
  }

  /** Look ahead without consuming, for the preview strip. */
  peek(count = 5) {
    return this.queue.slice(0, count);
  }

  serialize() {
    return { s: this.rng.getState(), q: this.queue.slice() };
  }

  restore(data) {
    if (!data) return;
    this.rng.setState(data.s);
    this.queue = data.q.slice();
  }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Human-friendly room codes: no vowels that read as words, no 0/O or 1/I. */
export function makeRoomCode(rng = Math.random) {
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  }
  return code;
}

export function normalizeRoomCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 5);
}