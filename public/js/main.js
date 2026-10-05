/**
 * Blockfall client entry point.
 *
 * Responsibilities:
 *  - menu, lobby, and game screens
 *  - solo play (fully local, no server needed)
 *  - room multiplayer: local prediction, server reconciliation
 *  - input handling for keyboard and touch
 */

// The simulation lives in /src and is imported by the browser and the Node
// server alike, so both sides are guaranteed to agree on the rules.
import { Game } from '../../src/core/game.js';
import { MSG, MODE_INFO } from '../../src/core/protocol.js';
import { Net } from './net.js';
import { Renderer } from './render.js';
import { sound } from './sound.js';

// Capture the browser globals once at module load. This keeps every lookup
// local to this instance instead of reaching through the global scope at call
// time, which is what lets two clients run side by side in the test suite.
const win = window;
const doc = win.document;
const loc = win.location;

const $ = (sel) => doc.querySelector(sel);
const $$ = (sel) => Array.from(doc.querySelectorAll(sel));

const COLORS = ['#22d3ee', '#3b82f6', '#f97316', '#facc15', '#22c55e', '#a855f7', '#ef4444', '#ec4899'];

const state = {
  screen: 'menu',
  net: null,
  game: null,          // local Game, either solo or prediction
  solo: false,
  room: null,          // last roomState payload
  roomCode: null,      // set once we have joined a room
  myId: null,
  spectatorId: null,
  name: '',
  color: COLORS[0],
  mode: 'marathon',
  settings: { mode: 'marathon', startingLevel: 1, linesToWin: 40, garbage: true, private: false, maxPlayers: 4 },
  paused: false,
  running: false,
  lastFrame: 0,
  rafId: null,
  disposed: false, // set by teardown()
  pendingInputs: [], // inputs sent but not yet reflected in a snapshot
  serverTimeOffset: 0, // server clock minus browser clock
  overData: null,
};

// ------------------------------------------------------------- boot

const profile = loadProfile();
state.name = profile.name;
state.color = profile.color;

buildColorPicker();
bindMenu();
bindLobby();
bindGame();

const renderer = new Renderer($('#board'), $('#holdCanvas'), $('#nextCanvas'));

$('#nameInput').value = state.name;
$('#soundToggle').checked = sound.enabled;

// Keyboard works on every screen.
win.addEventListener('keydown', onKeyDown, { passive: false });

// Show touch controls on coarse pointers.
if (win.matchMedia('(pointer: coarse)').matches) {
  $('#touchPad').classList.remove('hidden');
}

win.requestAnimationFrame(loop);

/**
 * Release every timer, listener and socket this client owns.
 *
 * Browsers never need this, but it lets the test suite boot many clients in a
 * single process without leaking loops.
 */
/**
 * Read-only view of internal state, for the browser tests and for debugging
 * in the console. Not used by the game itself.
 */
export function debug() {
  return {
    state,
    get net() {
      return state.net;
    },
    renderer,
  };
}

export function teardown() {
  state.disposed = true; // stops the animation loop from rescheduling
  stopGame();
  if (state.rafId) win.cancelAnimationFrame(state.rafId);
  state.rafId = null;
  state.net?.close();
  win.clearInterval(roomPollTimer);
  if (countdownTimer) win.clearInterval(countdownTimer);
  countdownTimer = null;
  stopDas();
  softHold = false;
}

// ------------------------------------------------------- profile helpers

function loadProfile() {
  try {
    const raw = localStorage.getItem('blockfall.profile');
    if (raw) {
      const p = JSON.parse(raw);
      return {
        name: String(p.name || '').slice(0, 16) || `Player${Math.floor(Math.random() * 900 + 100)}`,
        color: COLORS.includes(p.color) ? p.color : COLORS[0],
      };
    }
  } catch {
    /* fall through to defaults */
  }
  return {
    name: `Player${Math.floor(Math.random() * 900 + 100)}`,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  };
}

function saveProfile() {
  localStorage.setItem('blockfall.profile', JSON.stringify({ name: state.name, color: state.color }));
}

function buildColorPicker() {
  const box = $('#colorPicker');
  box.innerHTML = '';
  COLORS.forEach((c) => {
    const b = doc.createElement('button');
    b.className = 'swatch' + (c === state.color ? ' selected' : '');
    b.style.background = c;
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(c === state.color));
    b.dataset.color = c;
    b.addEventListener('click', () => {
      state.color = c;
      $$('#colorPicker .swatch').forEach((s) => {
        s.classList.toggle('selected', s.dataset.color === c);
        s.setAttribute('aria-checked', String(s.dataset.color === c));
      });
      saveProfile();
      sound.unlock();
      sound.ui();
    });
    box.appendChild(b);
  });
}

// ---------------------------------------------------------- menu screen

function bindMenu() {
  $('#nameInput').addEventListener('input', (e) => {
    state.name = e.target.value.slice(0, 16);
    saveProfile();
  });

  $$('#modePicker .mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#modePicker .mode-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.mode = btn.dataset.mode;
      state.settings.mode = state.mode;
      sound.unlock();
      sound.ui();
    });
  });

  bindRange('#startLevel', '#levelOut');
  bindRange('#linesToWin', '#goalOut');
  bindRange('#maxPlayers', '#maxOut');
  $('#garbageOn').addEventListener('change', (e) => {
    state.settings.garbage = e.target.checked;
  });
  $('#privateRoom').addEventListener('change', (e) => {
    state.settings.private = e.target.checked;
  });

  $('#btnSolo').addEventListener('click', startSolo);
  $('#btnCreate').addEventListener('click', () => ensureNet(() => connectAnd(MSG.JOIN, { name: state.name, color: state.color, settings: state.settings })));
  $('#btnQuick').addEventListener('click', () => {
    state.settings.mode = state.mode;
    ensureNet(() => connectAnd(MSG.QUICK_PLAY, { name: state.name, color: state.color, mode: state.mode }));
  });
  $('#btnJoin').addEventListener('click', () => {
    const code = $('#codeInput').value.trim().toUpperCase();
    if (!code) return toast('Enter a room code');
    ensureNet(() => connectAnd(MSG.JOIN, { name: state.name, color: state.color, code }));
  });
  $('#codeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btnJoin').click();
  });
}

function bindRange(inputSel, outSel) {
  const input = $(inputSel);
  const out = $(outSel);
  const sync = () => {
    out.textContent = input.value;
  };
  input.addEventListener('input', () => {
    sync();
    const key = input.id.replace('startLevel', 'startingLevel');
    if (input.id in state.settings) state.settings[input.id] = Number(input.value);
    else state.settings[key] = Number(input.value);
  });
  sync();
}

function startSolo() {
  sound.unlock();
  state.solo = true;
  state.game = new Game({
    seed: (Math.random() * 0xffffffff) >>> 0,
    startingLevel: state.settings.startingLevel,
    garbageMode: 'off',
  });
  state.room = null;
  showScreen('game');
  state.running = true;
  state.paused = false;
  state.overShown = false;
  state.syncAcc = 0;
  $('#gameOver').classList.add('hidden');
  $('#hudScore').textContent = '0';
  renderer.drawHold(null);
  renderer.drawNext(state.game.bag.peek(5));
  toast('Solo mode: play as long as you like. Esc to pause.');
}

// ------------------------------------------------------------ networking

/**
 * Make sure a live socket exists, then run `then` once it is open.
 * If the server is unreachable the action never fires and the banner shows,
 * so solo mode stays usable.
 */
function ensureNet(then) {
  sound.unlock();

  if (state.net && state.net.connected) {
    then();
    return;
  }
  if (!state.net) {
    state.net = new Net(win);
    wireNet(state.net);
  }
  if (state.pendingThen) return; // a connect is already in flight
  state.pendingThen = then;

  const onStatus = (status) => {
    if (status.state === 'connected') {
      state.net.off('status', onStatus);
      const fn = state.pendingThen;
      state.pendingThen = null;
      fn?.();
    } else if (status.state === 'disconnected') {
      // Let the auto-reconnect in Net try again; surface the failure once.
      if (!state.warnedOffline) {
        state.warnedOffline = true;
        toast('Cannot reach the game server. Solo mode still works.');
      }
    }
  };
  state.net.on('status', onStatus);
  state.net.connect();
}

/** Fire and forget: queue if the socket is not up yet. */
function connectAnd(t, payload) {
  state.net?.send({ t, ...payload });
}

/**
 * Get back into the room we were dropped from.
 *
 * Rooms live in server memory, so if the host slept or restarted the code may
 * be gone; in that case fall back to the menu rather than sitting on a
 * loading screen.
 */
function rejoinRoom() {
  const code = state.roomCode;
  if (!code) return;
  connectAnd(MSG.JOIN, { name: state.name, color: state.color, code, settings: state.settings });
}

function wireNet(net) {
  net.on('status', ({ state: s }) => {
    const banner = $('#connBanner');
    if (s === 'connected') {
      banner.classList.add('hidden');
      // If we were dropped from a room, try to get straight back in. Free
      // hosts sleep when idle, so this path is not hypothetical.
      if (state.roomCode) rejoinRoom();
    } else {
      banner.classList.remove('hidden');
      $('#connText').textContent = s === 'reconnecting' ? 'Reconnecting...' : 'Disconnected';
    }
  });

  net.on(MSG.HELLO, (msg) => {
    state.myId = msg.playerId ?? state.myId;
    state.spectatorId = msg.spectatorId ?? state.spectatorId;
    if (msg.playerId || msg.spectatorId) {
      state.warnedOffline = false;
      state.roomCode = null; // set once roomState confirms the room
    }
    if (msg.colors) {
      COLORS.length = 0;
      COLORS.push(...msg.colors);
    }
  });

  // During a match the server streams ROOM_STATE snapshots at 20Hz. Those are
  // both the authoritative board feed and the opponent mini-board feed.
  net.on(MSG.ROOM_STATE, (msg) => {
    state.room = msg;
    if (msg.serverTime) state.serverTimeOffset = msg.serverTime - Date.now();
    if (msg.status === 'playing') reconcile(msg);
    applyRoomState(msg);
  });

  net.on(MSG.ROOM_LIST, (msg) => {
    renderRoomList(msg.rooms || []);
    $('#roomCount').textContent = (msg.rooms || []).length;
  });

  // Keep the open-room list fresh while sitting on the menu.
  net.on('status', ({ state: s }) => {
    if (s === 'connected' && state.screen === 'menu') net.send({ t: MSG.LIST_ROOMS });
  });

  net.on(MSG.GAME_START, (msg) => {
    state.solo = false;
    state.room = msg;
    applyRoomState(msg);
    startMultiplayer(msg);
  });

  net.on(MSG.GAME_OVER, (msg) => {
    state.overData = msg;
    state.running = false;
    showResults(msg);
  });

  net.on(MSG.CHAT, (msg) => addChat(msg));

  net.on(MSG.ERROR, (msg) => {
  toast(msg.message || 'Error');
  // A room that no longer exists cannot be rejoined; go back to the menu.
  if (/No room called/.test(msg.message || '') && state.roomCode) {
    state.roomCode = null;
    state.room = null;
    stopGame();
    showScreen('menu');
    toast('That room is gone. Create a new one to keep playing.');
  }
});

  net.on(MSG.LEFT, () => {
    state.room = null;
    showScreen('menu');
    stopGame();
  });

  net.on(MSG.PONG, () => {});
}

// Refresh the room list every few seconds while the menu is visible.
const roomPollTimer = win.setInterval(() => {
  if (state.screen === 'menu' && state.net?.connected) state.net.send({ t: MSG.LIST_ROOMS });
}, 4000);

// ------------------------------------------------------------ lobby view

function bindLobby() {
  $('#lobbyBack').addEventListener('click', () => leaveRoom());
  $('#btnShare').addEventListener('click', shareInvite);
  $('#btnReady').addEventListener('click', () => {
    if (!state.net || !state.myId) return;
    const me = state.room?.players?.find((p) => p.id === state.myId);
    state.net.send({ t: MSG.SET_READY, ready: !(me && me.ready) });
  });
  $('#btnStart').addEventListener('click', () => {
    if (!state.net) return;
    state.net.send({ t: MSG.START });
  });

  $$('#lobbyModePicker .mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.net) return;
      state.net.send({ t: MSG.SET_SETTINGS, settings: { mode: btn.dataset.mode } });
      sound.ui();
    });
  });

  bindRange('#lobbyStartLevel', '#lobbyLevelOut');
  bindRange('#lobbyLinesToWin', '#lobbyGoalOut');
  $('#lobbyGarbage').addEventListener('change', (e) => {
    if (!state.net) return;
    state.net.send({ t: MSG.SET_SETTINGS, settings: { garbage: e.target.checked } });
  });

  $('#btnSendChat').addEventListener('click', sendChat);
  $('#chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
    e.stopPropagation();
  });
}

function sendChat() {
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text || !state.net) return;
  state.net.send({ t: MSG.CHAT, text });
  input.value = '';
}

function applyRoomState(msg) {
  const players = msg.players || [];
  const me = players.find((p) => p.id === state.myId);
  const settings = msg.settings || state.settings;

  $('#lobbyCode').textContent = msg.code || '-----';
  $('#lobbyMode').textContent = (MODE_INFO[settings.mode]?.label || 'Marathon') + ' â€” ' + (MODE_INFO[settings.mode]?.blurb || '');
  $('#lobbyPlayerCount').textContent = `${players.length}/${settings.maxPlayers}`;

  const list = $('#lobbyPlayers');
  list.innerHTML = '';
  for (const p of players) {
    const li = doc.createElement('li');
    li.className = 'player-row' + (p.dead ? ' dead' : '');

    const dot = doc.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;

    const name = doc.createElement('span');
    name.className = 'pname';
    name.textContent = p.name;
    if (p.host) {
      const tag = doc.createElement('em');
      tag.className = 'host-tag';
      tag.textContent = 'host';
      name.append(' ', tag);
    }

    const stat = doc.createElement('span');
    stat.className = 'pstat';
    stat.textContent = p.dead ? 'out' : `${p.lines} lines`;

    const ready = doc.createElement('span');
    ready.className = 'ready-chip' + (p.ready ? ' on' : '');
    ready.textContent = p.ready ? 'ready' : 'waiting';

    li.append(dot, name, stat, ready);
    list.appendChild(li);
  }

  if (me) {
    $('#btnReady').textContent = me.ready ? 'Not ready' : 'Ready';
    $('#btnReady').classList.toggle('btn-accent', !me.ready);
    const isHost = players.find((p) => p.host && p.id === state.myId);
    $('#btnStart').style.display = isHost ? '' : 'none';
    $('#hostBadge').classList.toggle('hidden', !isHost);
    doc.querySelectorAll('.host-panel .mode-btn, .host-panel input').forEach((el) => {
      el.disabled = !isHost;
    });
  }

  // Keep the lobby sliders in sync with server settings.
  const setVal = (sel, out, v) => {
    const el = $(sel);
    if (el && doc.activeElement !== el) {
      el.value = v;
      $(out).textContent = v;
    }
  };
  setVal('#lobbyStartLevel', '#lobbyLevelOut', settings.startingLevel);
  setVal('#lobbyLinesToWin', '#lobbyGoalOut', settings.linesToWin);
  if (settings.garbage !== undefined && doc.activeElement !== $('#lobbyGarbage')) {
    $('#lobbyGarbage').checked = settings.garbage;
  }
  $$('#lobbyModePicker .mode-btn').forEach((b) => b.classList.toggle('selected', b.dataset.mode === settings.mode));

  const allReady = players.length > 0 && players.every((p) => p.ready);
  $('#lobbyHint').textContent = allReady
    ? 'Everyone is ready.'
    : `Waiting for ${players.filter((p) => !p.ready).length} more player(s) to ready up.`;

  if (state.screen === 'menu') renderRoomList([msg]);

  // Opponent mini-boards while playing.
  if (state.screen === 'game' && state.room) renderOpponents(players, msg.boards || {});

  // Move between lobby and game as the match state changes. The server sends
  // status 'lobby' again once results have been shown for a second.
  if (msg.status === 'lobby' && state.screen !== 'menu' && state.roomCode === msg.code) {
    if (state.screen === 'game') $('#gameOver').classList.add('hidden');
    showScreen('lobby');
    stopGame();
  } else if (msg.status === 'lobby' && state.roomCode === null && msg.code) {
    state.roomCode = msg.code;
    showScreen('lobby');
  }
}

function renderRoomList(rooms) {
  const box = $('#roomList');
  if (!rooms.length) {
    box.innerHTML = '<p class="empty">No open rooms. Create one below.</p>';
    return;
  }
  box.innerHTML = '';
  for (const r of rooms) {
    const div = doc.createElement('div');
    div.className = 'room-row';

    const chip = doc.createElement('span');
    chip.className = 'code-chip small';
    chip.textContent = r.code;

    const mode = doc.createElement('span');
    mode.className = 'room-mode';
    mode.textContent = MODE_INFO[r.mode]?.label || r.mode;

    const players = doc.createElement('span');
    players.className = 'room-players';
    players.textContent = `${r.players}/${r.maxPlayers}`;

    const status = doc.createElement('span');
    status.className = `room-status ${r.status}`;
    status.textContent = r.status;

    const join = doc.createElement('button');
    join.className = 'btn btn-sm';
    join.textContent = 'Join';
    join.addEventListener('click', () => {
      ensureNet(() => connectAnd(MSG.JOIN, { name: state.name, color: state.color, code: r.code }));
    });

    div.append(chip, mode, players, status, join);
    box.appendChild(div);
  }
}

async function shareInvite() {
  const code = state.room?.code;
  if (!code) return;
  const url = `${loc.origin}${loc.pathname}#${code}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Blockfall', text: `Join my Blockfall room ${code}`, url });
      return;
    }
    await navigator.clipboard.writeText(`${code} â€” ${url}`);
    toast('Invite copied to clipboard');
  } catch {
    toast(`Share this code: ${code}`);
  }
}

function leaveRoom() {
  if (state.net) state.net.send({ t: MSG.LEAVE });
  state.room = null;
  state.roomCode = null;
  state.myId = null;
  state.overShown = false;
  $('#gameOver').classList.add('hidden');
  stopGame();
  showScreen('menu');
}

// --------------------------------------------------------- multiplayer

function startMultiplayer(msg) {
  state.solo = false;
  state.game = new Game({
    seed: ((msg.seed || 1) + (state.myId || 1) * 0x9e3779b9) >>> 0,
    startingLevel: msg.settings?.startingLevel || 1,
    garbageMode: msg.settings?.mode === 'versus' && msg.settings.garbage ? 'versus' : 'off',
    garbageCap: 8,
  });
  state.pendingInputs = [];
  state.paused = false;
  state.running = true;
  state.overData = null;
  state.overShown = false;
  $('#gameOver').classList.add('hidden');
  showScreen('game');
  runCountdown(3);
  updateHud();
}

function runCountdown(from) {
  const el = $('#countdown');
  let n = from;
  el.classList.remove('hidden');
  el.textContent = String(n);
  sound.countdown();
  win.clearInterval(countdownTimer);
  countdownTimer = win.setInterval(() => {
    n--;
    if (n <= 0) {
      win.clearInterval(countdownTimer);
      countdownTimer = null;
      el.classList.add('hidden');
      sound.go();
      return;
    }
    el.textContent = String(n);
    sound.countdown();
  }, 700);
}

/**
 * How long an input stays in the replay buffer.
 *
 * Snapshots come at 20Hz, so anything sent in the last ~120ms may not be
 * reflected in the snapshot we just received. We replay those on top of the
 * authoritative board so the piece never visibly jumps backwards.
 */
const REPLAY_WINDOW_MS = 130;

/**
 * Reconcile the locally predicted board with the server's authoritative one.
 *
 * The server is always right. If the board disagrees, we adopt the server
 * board and re-apply only the inputs that are likely still in flight, which
 * hides the network round trip without a full rollback implementation.
 */
function reconcile(msg) {
  if (state.solo || !state.game) return;
  const snap = msg.boards?.[state.myId];
  if (!snap) return;

  // Drop inputs old enough that the server has certainly seen them.
  const cutoff = Date.now() - REPLAY_WINDOW_MS;
  state.pendingInputs = state.pendingInputs.filter((p) => p.at > cutoff);

  if (encodeLocalBoard(state.game) === snap.b) return; // prediction matched

  const g = state.game;
  // The full piece queue only arrives on the opening snapshot, so keep
  // whatever we already have rather than inventing a new order.
  if (!snap.q) snap.q = g.bag.queue.slice();
  g.board = decodeInto(g.board, snap.b);
  g.piece = snap.p;
  g.rot = snap.r;
  g.px = snap.x;
  g.py = snap.y;
  g.hold = snap.h;
  g.holdUsed = false; // server does not track this across snapshots
  g.score = snap.s;
  g.lines = snap.l;
  g.level = snap.lv;
  g.combo = snap.c;
  g.b2b = snap.b2;
  g.dead = !!snap.d;
  g.pendingGarbage = snap.pg;
  g.clearAnim = snap.ca;
  g.clearRows = snap.cr || [];
  g.stats = snap.st || g.stats;
  g.elapsed = snap.t || 0;
  g.garbageTimer = 0;
  g.bag.queue = snap.q.slice();
  g.softDropping = false; // the server sends soft drop as separate events

  for (const p of state.pendingInputs) g.input(p.input);
}

function renderOpponents(players, boards) {
  const box = $('#opponents');
  const others = players.filter((p) => p.id !== state.myId);
  box.innerHTML = '';
  for (const p of others) {
    const wrap = doc.createElement('div');
    wrap.className = 'opponent' + (p.dead ? ' dead' : '');
    const canvas = doc.createElement('canvas');
    wrap.appendChild(canvas);

    const info = doc.createElement('div');
    info.className = 'opponent-info';
    const dot = doc.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    const name = doc.createElement('span');
    name.className = 'pname';
    name.textContent = p.name;
    const score = doc.createElement('span');
    score.className = 'pscore';
    score.textContent = `${p.lines}L · ${p.score.toLocaleString()}`;
    info.append(dot, name, score);

    wrap.appendChild(info);
    box.appendChild(wrap);
    renderer.drawMiniBoard(canvas, boards[p.id], Math.max(5, Math.floor(renderer.cell * 0.22)));
  }
}

// ------------------------------------------------------------ game loop

function bindGame() {
  $('#btnResume').addEventListener('click', () => setPaused(false));
  $('#btnRestart').addEventListener('click', () => {
    setPaused(false);
    if (state.solo) startSolo();
    // In a room the server owns the match, so ask the host to start a new one.
    else toast('Only the host can restart a room match.');
  });
  $('#btnLeave').addEventListener('click', () => {
    setPaused(false);
    leaveRoom();
  });
  $('#btnAgain').addEventListener('click', () => {
  $('#gameOver').classList.add('hidden');
  if (state.solo) {
    startSolo();
    return;
  }
  // Vote for a rematch; the room starts a new match once everyone has voted.
  if (state.net) {
    state.net.send({ t: MSG.REMATCH });
    toast('Rematch requested. Waiting for everyone...');
    showScreen('lobby');
  } else startSolo();
});
  $('#btnQuit').addEventListener('click', () => {
    $('#gameOver').classList.add('hidden');
    if (state.solo) {
      stopGame();
      showScreen('menu');
    } else leaveRoom();
  });
  $('#btnPause').addEventListener('click', () => setPaused(!state.paused));
  $('#soundToggle').addEventListener('change', (e) => sound.setEnabled(e.target.checked));

  $$('#touchPad .tbtn').forEach((btn) => {
    const act = btn.dataset.act;
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      sound.unlock();
      handleAction(act);
    }, { passive: false });
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      sound.unlock();
      handleAction(act);
    });
  });
}

function handleAction(act) {
  switch (act) {
    case 'left': sendInput({ dx: -1 }); sound.move(); break;
    case 'right': sendInput({ dx: 1 }); sound.move(); break;
    case 'rotcw': sendInput({ rot: 1 }); sound.rotate(); break;
    case 'rotccw': sendInput({ rot: -1 }); sound.rotate(); break;
    case 'drop': sendInput({ hardDrop: true }); break;
    default: break;
  }
}

function sendInput(input) {
  if (!state.game || state.paused || state.game.dead) return;
  // Predict locally so input feels instant, then tell the server.
  state.game.input(input);
  if (state.solo) return;
  state.pendingInputs.push({ input, at: Date.now() });
  if (state.pendingInputs.length > 120) state.pendingInputs.shift();
  state.net?.send({ t: MSG.INPUT, input });
}

function setPaused(p) {
  if (state.solo || !state.running) {
    if (state.solo) state.paused = p;
    $('#pause').classList.toggle('hidden', !p);
    return;
  }
  state.paused = p;
  $('#pause').classList.toggle('hidden', !p);
}

/**
 * Detach the running game. The render loop itself keeps running (it only
 * stops on teardown) because the menu and lobby still animate.
 */
function stopGame() {
  state.running = false;
  state.game = null;
  state.pendingInputs = [];
  state.overShown = false;
}

function loop(now) {
  if (state.disposed) return; // teardown() was called

  const dt = Math.min(now - (state.lastFrame || now), 100);
  state.lastFrame = now;

  if (state.screen === 'game' && state.game && state.running && !state.paused) {
    step(dt);
    draw();
  }

  state.rafId = win.requestAnimationFrame(loop);
}

function step(dt) {
  const g = state.game;
  g.tick(dt);

  // Play sounds for anything the engine reported this frame.
  for (const ev of g.drainEvents()) {
    switch (ev.type) {
      case 'lock':
        sound.lock();
        break;
      case 'clear': {
        const special = ev.data.tspin || ev.data.perfect;
        sound.clear(ev.data.lines, special);
        renderer.shake = ev.data.lines >= 4 ? 6 : 2;
        flashText(ev.data);
        break;
      }
      case 'levelup':
        sound.levelUp();
        break;
      case 'incoming':
        sound.garbage();
        renderer.shake = 8;
        break;
      case 'topout':
        onTopOut();
        break;
      default:
        break;
    }
  }

  if (g.dead && !state.overShown) {
    state.overShown = true;
    if (state.solo) {
      state.running = false;
      sound.gameOver();
      showResults({
        ranked: [{ id: 'me', name: state.name, color: state.color, rank: 1, score: g.score, lines: g.lines, level: g.level, pps: 0, stats: g.stats }],
        solo: true,
      });
    }
  }
}

function onTopOut() {
  state.overShown = true;
  sound.gameOver();
}

function draw() {
  const g = state.game;
  renderer.drawBoard(g);
  renderer.drawHold(g.hold);
  renderer.drawNext(g.bag.peek(5));
  updateHud();
}

function updateHud() {
  const g = state.game;
  if (!g) return;
  setText('#hudScore', g.score.toLocaleString());
  setText('#hudLines', g.lines);
  setText('#hudLevel', g.level);
  setText('#hudTime', formatTime(g.elapsed));
}

function flashText(clear) {
  const overlay = $('#flashOverlay');
  const label =
    (clear.perfect ? 'PERFECT CLEAR! ' : clear.tspin ? (clear.mini ? 'T-SPIN MINI ' : 'T-SPIN ') : '') +
    ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'QUAD!'][clear.lines] +
    (clear.combo > 0 ? ` x${clear.combo + 1}` : '') +
    (clear.b2b ? ' B2B' : '');
  if (!label.trim()) return;
  overlay.textContent = label;
  overlay.classList.remove('show');
  // Restart the CSS animation.
  void overlay.offsetWidth;
  overlay.classList.add('show');
}

// ------------------------------------------------------------- results

function showResults(msg) {
  const ranked = msg.ranked || [];
  const list = $('#finalScores');
  list.innerHTML = '';
  for (const r of ranked) {
    const li = doc.createElement('li');
    li.className = r.id === state.myId || msg.solo ? 'me' : '';
    const rank = doc.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(r.rank);

    const dot = doc.createElement('span');
    dot.className = 'dot';
    dot.style.background = r.color;

    const name = doc.createElement('span');
    name.className = 'pname';
    name.textContent = r.name;

    const score = doc.createElement('span');
    score.className = 'pscore';
    score.textContent = r.score.toLocaleString();

    const meta = doc.createElement('span');
    meta.className = 'pmeta';
    const parts = [`${r.lines} lines`, `level ${r.level}`];
    if (r.finishedAt) parts.push(`${(r.finishedAt / 1000).toFixed(2)}s`);
    meta.textContent = parts.join(' · ');

    li.append(rank, dot, name, score, meta);
    list.appendChild(li);
  }
  $('#overTitle').textContent = msg.solo ? 'Game over' : 'Match over';
  $('#gameOver').classList.remove('hidden');
}

// -------------------------------------------------------------- input

function onKeyDown(e) {
  // Ignore typing in the name/chat fields. The target is not always an element
  // (it can be the window itself), so feature-test before using matches().
  const t = e.target;
  if (t && typeof t.matches === 'function' && t.matches('input, textarea')) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    if (state.screen === 'game' && state.running) setPaused(!state.paused);
    return;
  }
  if (state.screen !== 'game' || !state.running || state.paused) return;

  sound.unlock();

  switch (e.key) {
    case 'ArrowLeft': e.preventDefault(); handleAction('left'); break;
    case 'ArrowRight': e.preventDefault(); handleAction('right'); break;
    case 'ArrowDown': e.preventDefault(); sendInput({ softDrop: true }); softHold = true; break;
    case 'ArrowUp': case 'x': case 'X': e.preventDefault(); handleAction('rotcw'); break;
    case 'z': case 'Z': e.preventDefault(); handleAction('rotccw'); break;
    case ' ': e.preventDefault(); handleAction('drop'); break;
    case 'c': case 'C': case 'Shift': e.preventDefault(); sendInput({ hold: true }); sound.hold(); break;
    default: break;
  }
}

/** True while the soft-drop key is held, so keyup knows to send a release. */
let softHold = false;

/** Active countdown interval, cleared by teardown. */
let countdownTimer = null;

// Release soft drop and taps on key-up.
win.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowDown' && softHold) {
    softHold = false;
    sendInput({ softDrop: false });
  }
});

/*
 * Delayed Auto Shift: tapping moves once, holding repeats. The first repeat
 * lands after DAS_MS, then ARR_MS between repeats.
 */
const DAS_MS = 140;
const ARR_MS = 45;
let dasTimer = null;

function startDas(dx) {
  if (dasTimer) return;
  dasTimer = win.setTimeout(function repeat() {
    sendInput({ dx });
    dasTimer = win.setTimeout(repeat, ARR_MS);
  }, DAS_MS);
}

function stopDas() {
  if (dasTimer) win.clearTimeout(dasTimer);
  dasTimer = null;
}

win.addEventListener('keydown', (e) => {
  if (state.screen !== 'game' || !state.running || state.paused) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  startDas(e.key === 'ArrowLeft' ? -1 : 1);
});
win.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') stopDas();
});
// A lost focus would otherwise leave the piece sliding forever.
win.addEventListener('blur', () => {
  stopDas();
  if (softHold) {
    softHold = false;
    sendInput({ softDrop: false });
  }
});

// --------------------------------------------------------------- helpers

function showScreen(name) {
  state.screen = name;
  $$('.screen').forEach((s) => s.classList.remove('active'));
  const el = doc.getElementById(name);
  if (el) el.classList.add('active');
  if (name !== 'game') state.paused = false;
  $('#pause').classList.add('hidden');
}

function toast(text) {
  const box = $('#toasts');
  const el = doc.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.classList.remove('show'), 10);
  win.requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

function addChat(msg) {
  const log = $('#chatLog');
  const el = doc.createElement('div');
  el.className = 'chat-line' + (msg.system ? ' system' : '');

  // Built from nodes rather than innerHTML so a chat line can never inject
  // markup, even if the server were compromised.
  if (msg.system) {
    el.textContent = msg.text;
  } else {
    const dot = doc.createElement('span');
    dot.className = 'dot';
    dot.style.background = msg.color || '#94a3b8';
    const who = doc.createElement('b');
    who.textContent = msg.name;
    el.append(dot, who, doc.createTextNode(' ' + msg.text));
  }

  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 100) log.removeChild(log.firstChild);
}

function setText(sel, text) {
  const el = $(sel);
  if (el && el.textContent !== String(text)) el.textContent = text;
}

function formatTime(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Pack the board into the same one-character-per-cell string the server uses,
 * so a prediction can be compared against a snapshot in O(200).
 */
function encodeLocalBoard(g) {
  let out = '';
  for (let i = 0; i < g.board.length; i++) {
    const v = g.board[i];
    out += v === 8 ? 'g' : String(v);
  }
  return out;
}

function decodeInto(target, str) {
  for (let i = 0; i < target.length; i++) {
    const code = str.charCodeAt(i);
    target[i] = code === 103 ? 8 : code - 48;
  }
  return target;
}

$('#btnReconnect').addEventListener('click', () => state.net?.connect());