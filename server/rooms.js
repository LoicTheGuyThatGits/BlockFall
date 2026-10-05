/**
 * Room registry and room lifecycle.
 *
 * A room owns its players, settings and (during a match) a Game instance per
 * player. The server never trusts the client for game state; it only accepts
 * input events and broadcasts snapshots.
 */

import { Game } from '../src/core/game.js';
import { makeRoomCode, normalizeRoomCode } from '../src/core/rng.js';
import { DEFAULT_SETTINGS, MSG } from '../src/core/protocol.js';

const SNAPSHOT_HZ = 20; // board snapshots per second per room
const EMPTY_ROOM_TTL_MS = 60_000; // reap a room once it has been empty this long
const PLAYER_LIMIT = 4;

let nextPlayerId = 1;

export class Room {
  constructor(code, ws, opts = {}) {
    this.code = code;
    this.creatorWs = ws; // who made the room, used for host fallback
    this.hostId = null;
    this.players = new Map(); // id -> player
    this.spectators = new Map();
    this.settings = { ...DEFAULT_SETTINGS, ...opts.settings };
    this.createdAt = Date.now();
    this.emptySince = null;
    this.status = 'lobby'; // lobby | playing | over
    this.messages = [];
    this.seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    this.tickAccum = 0;
    this.snapshotAccum = 0;
    this.lastTick = Date.now();
    this.rematchVotes = new Set();
    this.ppsAt = 0;
    this.matchPlayerCount = 0; // players seated when the match started
  }

  get playerList() {
    return [...this.players.values()].map((p) => this.publicPlayer(p));
  }

  get spectatorCount() {
    return this.spectators.size;
  }

  publicPlayer(p) {
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      ready: p.ready,
      host: p.id === this.hostId,
      score: p.game ? p.game.score : 0,
      lines: p.game ? p.game.lines : 0,
      level: p.game ? p.game.level : 1,
      dead: p.game ? p.game.dead : false,
      pps: p.pps || 0,
      finishedAt: p.finishedAt || null,
    };
  }

  // ------------------------------------------------------------ membership

  join(ws, { name, color }) {
    const id = nextPlayerId++;
    const player = {
      id,
      ws,
      name: sanitizeName(name) || `Player${id}`,
      color: clampColor(color),
      ready: false,
      game: null,
      attackQueue: 0,
      pendingInput: null,
      finishedAt: null,
      dyingHandled: false,
      queueSynced: false, // a fresh joiner needs the full piece queue
      lastSeen: Date.now(),
      pps: 0,
      ppsMark: 0,
      pieceMark: 0,
    };
    this.players.set(id, player);
    if (this.hostId === null) this.hostId = id;
    this.emptySince = null;
    return player;
  }

  leave(id) {
    const p = this.players.get(id);
    this.players.delete(id);
    if (this.hostId === id) {
      // Hand the room to the next person so the match can continue.
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }
    if (this.players.size === 0) {
      this.emptySince = Date.now();
      return null;
    }
    // Dropping out mid-match should end a versus game that was already won.
    this.checkMatchEnd();
    return p || null;
  }

  spectate(ws) {
    const id = nextPlayerId++;
    const s = { id, ws, name: `Spectator${id}` };
    this.spectators.set(id, s);
    return s;
  }

  unspectate(id) {
    this.spectators.delete(id);
  }

  // ---------------------------------------------------------------- lobby

  setReady(id, ready) {
    const p = this.players.get(id);
    if (!p) return;
    p.ready = !!ready;
  }

  setSettings(id, patch) {
    if (this.hostId !== id) return false;
    if (this.status !== 'lobby') return false;
    const s = { ...this.settings };

    if (patch.mode && ['marathon', 'sprint', 'versus'].includes(patch.mode)) s.mode = patch.mode;
    if (patch.startingLevel !== undefined) {
      s.startingLevel = Math.max(1, Math.min(15, parseInt(patch.startingLevel, 10) || 1));
    }
    if (patch.linesToWin !== undefined) {
      s.linesToWin = Math.max(1, Math.min(100, parseInt(patch.linesToWin, 10) || 40));
    }
    if (patch.garbage !== undefined) s.garbage = !!patch.garbage;
    if (patch.private !== undefined) s.private = !!patch.private;
    if (patch.allowSpectators !== undefined) s.allowSpectators = !!patch.allowSpectators;
    if (patch.maxPlayers !== undefined) {
      s.maxPlayers = Math.max(1, Math.min(PLAYER_LIMIT, parseInt(patch.maxPlayers, 10) || 4));
    }
    this.settings = s;
    return true;
  }

  canStart() {
    if (this.status !== 'lobby') return 'A match is already running';
    if (this.players.size < 1) return 'Need at least one player';
    if (this.players.size > this.settings.maxPlayers) return 'Room is full';
    for (const p of this.players.values()) if (!p.ready) return 'Everyone must be ready';
    return null;
  }

  // ---------------------------------------------------------------- match

  start() {
    const err = this.canStart();
    if (err) return err;

    this.seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    this.status = 'playing';
    this.rematchVotes.clear();
    this.startedAt = Date.now();
    this.matchPlayerCount = this.players.size;
    this.lastTick = Date.now();
    this.tickAccum = 0;
    this.snapshotAccum = 0;

    const garbageMode = this.settings.mode === 'versus' && this.settings.garbage ? 'versus' : 'off';

    for (const p of this.players.values()) {
      // Offset each player's seed from the room seed so the match is not a
      // pure mirror, but keep it deterministic for that player.
      const seed = (this.seed + p.id * 0x9e3779b9) >>> 0;
      p.game = new Game({
        seed,
        startingLevel: this.settings.startingLevel,
        garbageMode,
        garbageCap: this.settings.mode === 'versus' ? 8 : 0,
      });
      p.attackQueue = 0;
      p.pendingInput = null;
      p.finishedAt = null;
      p.dyingHandled = false;
      p.pieceMark = 0;
      p.ppsMark = this.startedAt;
      p.ready = false;
      p.queueSynced = false; // resend the full queue on the next snapshot
    }

    this.broadcast(MSG.GAME_START, {
      seed: this.seed,
      settings: this.settings,
      players: this.playerList,
      startedAt: this.startedAt,
    });
    // The first snapshot carries full piece queues so clients start in sync.
    this.broadcastState({ full: true });
    return null;
  }

  /** Queue a hard drop etc. from a player; applied on the next tick. */
  queueInput(id, input) {
    const p = this.players.get(id);
    if (!p || !p.game || this.status !== 'playing') return;
    p.pendingInput = p.pendingInput || [];
    // Bound the queue so a client cannot flood the server.
    if (p.pendingInput.length < 64) p.pendingInput.push(input);
  }

  /**
   * Fixed-step simulation. Timesteps are clamped so a backgrounded tab or a
   * laggy event loop cannot fast-forward the whole match.
   */
  update(now) {
    if (this.status === 'lobby' || this.status === 'over') return;

    let delta = now - this.lastTick;
    this.lastTick = now;
    if (delta < 0) delta = 0;
    if (delta > 250) delta = 250; // never fast-forward a stalled event loop

    const STEP = 1000 / 60;
    this.tickAccum += delta;
    let steps = 0;
    while (this.tickAccum >= STEP && steps < 8) {
      this.tickAccum -= STEP;
      steps++;
      this.step(STEP, now);
    }

    this.snapshotAccum += delta;
    if (this.snapshotAccum >= 1000 / SNAPSHOT_HZ) {
      this.snapshotAccum = 0;
      this.broadcastState();
    }
  }

  step(dt, now) {
    const vs = this.settings.mode === 'versus' && this.settings.garbage;

    for (const p of this.players.values()) {
      const g = p.game;
      if (!g) continue;
      p.lastSeen = now;

      if (p.pendingInput && p.pendingInput.length) {
        for (const input of p.pendingInput) {
          g.input(input);
          // Attacker queues generated garbage for delivery below.
          if (g.pendingAttack) p.attackQueue += g.pendingAttack;
        }
        p.pendingInput = null;
      }

      g.tick(dt);
      p.pieceCount = g.pieces;

      // Sprint / marathon finishing.
      if (this.settings.mode === 'sprint' && !p.finishedAt && g.lines >= this.settings.linesToWin) {
        p.finishedAt = now - this.startedAt;
        this.broadcast(MSG.CHAT, {
          system: true,
          text: `${p.name} finished in ${(p.finishedAt / 1000).toFixed(2)}s`,
        });
        this.checkMatchEnd();
      }
    }

    // Garbage exchange.
    if (vs) {
      for (const p of this.players.values()) {
        if (p.attackQueue <= 0 || !p.game || p.game.dead) continue;
        const amt = p.attackQueue;
        p.attackQueue = 0;
        for (const target of this.players.values()) {
          if (target.id === p.id || !target.game || target.game.dead) continue;
          target.game.addGarbage(amt);
        }
      }
    }

    // Deckies.
    for (const p of this.players.values()) {
      if (p.game && p.game.dead && !p.dyingHandled) {
        p.dyingHandled = true;
        this.broadcast(MSG.CHAT, { system: true, text: `${p.name} topped out` });
        this.checkMatchEnd();
      }
    }

    // pps (pieces per second) for the scoreboard.
    if (now - (this.ppsAt || 0) > 500) {
      this.ppsAt = now;
      for (const p of this.players.values()) {
        if (!p.game) continue;
        const dt = (now - (p.ppsMark || now)) / 1000;
        if (dt > 0) p.pps = (p.game.pieces - (p.pieceMark ?? p.game.pieces)) / dt;
        p.pieceMark = p.game.pieces;
        p.ppsMark = now;
      }
    }
  }

  checkMatchEnd() {
    if (this.status !== 'playing') return;
    const alive = [...this.players.values()].filter((p) => p.game && !p.game.dead);

    if (this.settings.mode === 'versus') {
      // A one-player versus room is really a solo game, so it never ends on
      // the "last one standing" rule. Compare against the size the match
      // started with, so a player dropping out still decides it.
      if (this.matchPlayerCount >= 2 && alive.length <= 1) this.endMatch();
      return;
    }
    if (this.settings.mode === 'sprint') {
      const finished = [...this.players.values()].filter((p) => p.finishedAt);
      if (finished.length >= this.players.size || (finished.length >= 1 && alive.length === 0)) {
        this.endMatch();
      }
      return;
    }
    // Marathon ends when everyone is dead.
    if (alive.length === 0) this.endMatch();
  }

  endMatch() {
    if (this.status === 'over') return;
    this.status = 'over';
    const ranked = [...this.players.values()]
      .sort((a, b) => {
        if (this.settings.mode === 'sprint') {
          return (a.finishedAt ?? Infinity) - (b.finishedAt ?? Infinity);
        }
        return (b.game?.score ?? 0) - (a.game?.score ?? 0);
      })
      .map((p, i) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        rank: i + 1,
        score: p.game?.score ?? 0,
        lines: p.game?.lines ?? 0,
        level: p.game?.level ?? 1,
        pieces: p.game?.pieces ?? 0,
        pps: p.pps || 0,
        finishedAt: p.finishedAt ?? null,
        stats: p.game?.stats ?? {},
      }));

    this.broadcast(MSG.GAME_OVER, { ranked, settings: this.settings });
    // Back to the lobby so people can queue a rematch.
    setTimeout(() => {
      if (this.status === 'over') {
        this.status = 'lobby';
        for (const p of this.players.values()) {
          p.game = null;
          p.ready = false;
          p.dyingHandled = false;
          p.attackQueue = 0;
          p.pendingInput = null;
        }
        this.rematchVotes.clear();
        this.broadcastState();
      }
    }, 1000);
  }

  requestRematch(id) {
    if (this.status !== 'lobby' && this.status !== 'over') return;
    this.rematchVotes.add(id);
    if (this.rematchVotes.size >= this.players.size && this.players.size > 0) {
      for (const p of this.players.values()) p.ready = true;
      this.start();
    }
  }

  // --------------------------------------------------------------- output

  snapshotFor(p, opts) {
    if (!p.game) return null;
    return p.game.snapshot(opts);
  }

  /**
   * A client needs the full piece queue whenever it adopts a fresh snapshot as
   * its baseline: at the start of a match, and when it (re)joins one already in
   * progress. Without it, a late joiner would fall back to its own idea of the
   * queue and diverge from the server.
   */
  needsFullQueue(p) {
    return this.status !== 'playing' || !p.queueSynced;
  }

  /**
   * @param {object} opts
   * @param {boolean} opts.full   include each full piece queue
   * @param {boolean} opts.stats  include end-of-match statistics
   */
  buildState({ full = false, stats = false } = {}) {
    const boards = {};
    for (const p of this.players.values()) {
      boards[p.id] = this.snapshotFor(p, { full: full || this.needsFullQueue(p), stats });
      if (boards[p.id]) p.queueSynced = true;
    }
    return {
      code: this.code,
      status: this.status,
      settings: this.settings,
      players: this.playerList,
      spectatorCount: this.spectators.size,
      boards,
      serverTime: Date.now(),
      startedAt: this.startedAt,
    };
  }

  broadcastState(opts = {}) {
    const msg = JSON.stringify({ t: MSG.ROOM_STATE, ...this.buildState(opts) });
    for (const p of this.players.values()) this.safeSend(p.ws, msg);
    for (const s of this.spectators.values()) this.safeSend(s.ws, msg);
  }

  broadcast(t, payload) {
    const msg = JSON.stringify({ t, ...payload });
    for (const p of this.players.values()) this.safeSend(p.ws, msg);
    for (const s of this.spectators.values()) this.safeSend(s.ws, msg);
  }

  chat(ws, text) {
    const player = this.findByWs(ws);
    const clean = String(text || '').slice(0, 200);
    if (!clean) return;
    const entry = {
      playerId: player ? player.id : null,
      name: player ? player.name : 'Guest',
      color: player ? player.color : '#94a3b8',
      text: clean,
      at: Date.now(),
    };
    this.messages.push(entry);
    if (this.messages.length > 50) this.messages.shift();
    this.broadcast(MSG.CHAT, entry);
  }

  findByWs(ws) {
    for (const p of this.players.values()) if (p.ws === ws) return p;
    return null;
  }

  findSpectatorByWs(ws) {
    for (const s of this.spectators.values()) if (s.ws === ws) return s;
    return null;
  }

  safeSend(ws, msg) {
    try {
      if (ws.readyState === 1) ws.send(msg);
    } catch {
      /* connection is gone; the close handler will clean up */
    }
  }

  summary() {
    return {
      code: this.code,
      mode: this.settings.mode,
      status: this.status,
      players: this.players.size,
      maxPlayers: this.settings.maxPlayers,
      private: this.settings.private,
      host: this.hostId,
    };
  }

  /** True when the room has been empty long enough to reap. */
  isExpired(now) {
    return this.players.size === 0 && this.spectators.size === 0 && this.emptySince && now - this.emptySince > EMPTY_ROOM_TTL_MS;
  }
}

// ------------------------------------------------------------- registry

export class RoomRegistry {
  constructor() {
    this.rooms = new Map();
  }

  create(ws, opts = {}) {
    const code = opts.code ? normalizeRoomCode(opts.code) : makeRoomCode();
    let unique = code;
    let n = 0;
    while (this.rooms.has(unique)) {
      unique = `${code}${++n}`.slice(0, 6);
    }
    const room = new Room(unique, ws, opts);
    this.rooms.set(unique, room);
    return room;
  }

  get(code) {
    return this.rooms.get(normalizeRoomCode(code)) || null;
  }

  /** Find a joinable public room for the quick-play button. */
  findQuickPlay(mode) {
    for (const room of this.rooms.values()) {
      if (room.settings.private) continue;
      if (room.status !== 'lobby') continue;
      if (room.players.size >= room.settings.maxPlayers) continue;
      if (mode && room.settings.mode !== mode) continue;
      return room;
    }
    return null;
  }

  list() {
    return [...this.rooms.values()]
      .filter((r) => r.players.size > 0)
      .map((r) => r.summary());
  }

  sweep(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      if (room.isExpired(now)) this.rooms.delete(code);
    }
  }
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[^\p{L}\p{N} _\-.]/gu, '')
    .trim()
    .slice(0, 16);
}

const COLORS = ['#22d3ee', '#3b82f6', '#f97316', '#facc15', '#22c55e', '#a855f7', '#ef4444', '#ec4899'];
function clampColor(color) {
  return COLORS.includes(color) ? color : COLORS[0];
}

export { COLORS, sanitizeName };