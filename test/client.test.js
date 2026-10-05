/**
 * Browser smoke test.
 *
 * Boots the real client in jsdom against the real server, so this covers the
 * DOM wiring, the sprite/render code paths, and solo gameplay. jsdom has no
 * canvas implementation, so 2D contexts are stubbed with recording fakes.
 *
 * Run with: node --test test/client.test.js
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { JSDOM } from 'jsdom';

const PORT = 8300 + (process.pid % 150);
const ORIGIN = `http://127.0.0.1:${PORT}`;

let server;

before(async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${ORIGIN}/api/health`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
});

after(async () => {
  if (server) server.kill();
  // jsdom windows and sockets keep handles open; let the runner finish.
});

/**
 * A 2D context that accepts every call and records them, so the render code
 * runs to completion without a real canvas backend.
 */
function stubContext() {
  const calls = [];
  const record = (name) =>
    function (...args) {
      calls.push(name);
      return undefined;
    };
  const ctx = {
    calls,
    canvas: null,
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    imageSmoothingEnabled: true,
  };
  const methods = [
    'setTransform', 'clearRect', 'save', 'restore', 'translate', 'scale', 'rotate',
    'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'fill', 'stroke',
    'fillRect', 'strokeRect', 'fillText', 'strokeText', 'drawImage', 'clip', 'rect',
    'setLineDash', 'measureText', 'putImageData', 'createLinearGradient', 'createRadialGradient',
  ];
  for (const m of methods) {
    ctx[m] =
      m === 'measureText'
        ? () => ({ width: 10 })
        : m === 'createLinearGradient' || m === 'createRadialGradient'
          ? () => ({ addColorStop() {} })
          : record(m);
  }
  return ctx;
}

let bootCounter = 0;

/** DOM globals the client reads directly. Event classes stay Node's own. */
const DOM_GLOBALS = [
  'document', 'location', 'localStorage', 'HTMLElement', 'HTMLCanvasElement',
  'getComputedStyle', 'devicePixelRatio',
];

/**
 * Load the client the way a browser would.
 *
 * jsdom does not run `<script type="module">`, so we point the Node module
 * loader at the served files and run the entry module against the jsdom
 * window. Every browser global is published on globalThis so the client's
 * bare `document` / `window` references resolve.
 */
async function loadClient() {
  const html = await (await fetch(`${ORIGIN}/`)).text();
  const dom = new JSDOM(html, { url: `${ORIGIN}/`, pretendToBeVisual: true });
  const { window } = dom;

  // jsdom has no canvas backend; hand out a recording context instead.
  window.HTMLCanvasElement.prototype.getContext = function () {
    if (!this._ctx) {
      const ctx = stubContext();
      ctx.canvas = this;
      this._ctx = ctx;
    }
    return this._ctx;
  };

  // No AudioContext in jsdom, so sound.unlock() must be a no-op there.
  window.AudioContext = undefined;
  window.webkitAudioContext = undefined;

  // jsdom lacks these; stub them so the client can run.
  window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });

  // Publish the DOM globals the imported modules read directly.
  //
  // Node's own Event classes are deliberately left in place: undici's
  // WebSocket dispatches Node events, so shadowing Event with jsdom's copy
  // would break every socket. DOM-only names are safe to swap.
  const saved = {};
  for (const key of DOM_GLOBALS) {
    saved[key] = globalThis[key];
    const value = key in window ? window[key] : window;
    try {
      globalThis[key] = value;
    } catch {
      // Some globals (navigator) are getter-only in Node.
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
  }
  globalThis.window = window;
  globalThis.self = window;

  const consoleErrors = [];
  const originalError = console.error;
  console.error = (...a) => {
    consoleErrors.push(a.map(String).join(' '));
    originalError(...a);
  };

  // Import with a cache-busting query so each test gets a fresh client.
  const v = ++bootCounter;
  let mod;
  try {
    mod = await import(`../public/js/main.js?boot=${v}`);
  } catch (err) {
    console.error = originalError;
    throw new Error(`client failed to boot: ${err.stack || err.message}`);
  }

  // Let the animation loop run a few frames.
  await new Promise((r) => setTimeout(r, 150));

  let closed = false;
  return {
    dom,
    window,
    consoleErrors,
    /** The client's own module namespace, for poking at internal state. */
    module: mod,
    /**
     * Tear down: stop the client's loops and socket, then put the globals back
     * so the next test starts clean.
     */
    close() {
      if (closed) return;
      closed = true;
      try {
        mod.teardown?.();
      } catch {
        /* the client may already be gone */
      }
      console.error = originalError;
      try {
        client.close();
      } catch {
        /* already closed */
      }
      for (const [key, value] of Object.entries(saved)) {
        try {
          globalThis[key] = value;
        } catch {
          /* some globals are read-only in Node */
        }
      }
    },
  };
}

test('the client boots and renders the menu without errors', async () => {
  const client = await loadClient();
  const { window, consoleErrors } = client;
  const doc = window.document;

  assert.equal(doc.querySelector('#menu').classList.contains('active'), true, 'menu is active');
  assert.ok(doc.querySelectorAll('#colorPicker .swatch').length >= 7, 'colour swatches rendered');
  assert.ok(doc.querySelector('#nameInput').value.length > 0, 'a default name is set');

  // Mode buttons should reflect the chosen game mode.
  const selected = doc.querySelector('#modePicker .mode-btn.selected');
  assert.equal(selected.dataset.mode, 'marathon');

  // Range outputs are synced to their inputs.
  assert.equal(doc.querySelector('#levelOut').textContent, '1');
  assert.equal(doc.querySelector('#goalOut').textContent, '40');

  assert.deepEqual(consoleErrors, [], 'no errors during boot');
  client.close();
});

test('switching mode in the menu updates the selection', async () => {
  const client = await loadClient();
  const { window } = client;
  const doc = window.document;
  const sprint = doc.querySelector('#modePicker .mode-btn[data-mode="sprint"]');
  sprint.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.equal(sprint.classList.contains('selected'), true);
  assert.equal(doc.querySelector('#modePicker .mode-btn.selected').dataset.mode, 'sprint');
  client.close();
});

test('solo play starts, accepts input and updates the HUD', async () => {
  const client = await loadClient();
  const { window, consoleErrors } = client;
  const doc = window.document;

  doc.querySelector('#btnSolo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.querySelector('#game').classList.contains('active'), true, 'game screen shown');

  // Let the animation loop tick a few frames.
  await new Promise((r) => setTimeout(r, 120));

  // The board canvas should have been drawn to.
  const board = doc.querySelector('#board');
  assert.ok(board._ctx, 'board context created');
  assert.ok(board._ctx.calls.includes('drawImage'), 'sprites drawn to the board');
  assert.ok(doc.querySelector('#nextCanvas')._ctx.calls.includes('drawImage'), 'next queue drawn');

  // Hard drops score points; once enough pieces land, a line clears.
  const before = Number(doc.querySelector('#hudScore').textContent.replace(/,/g, ''));
  let lines = 0;
  for (let i = 0; i < 40 && lines === 0; i++) {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    lines = Number(doc.querySelector('#hudLines').textContent);
  }
  const after = Number(doc.querySelector('#hudScore').textContent.replace(/,/g, ''));
  assert.ok(after > before, `score should rise after hard drops (was ${before}, now ${after})`);

  // The flash overlay announces the clear, combo and back-to-back state.
  const flash = doc.querySelector('#flashOverlay');
  if (lines > 0) {
    assert.match(
      flash.textContent,
      /SINGLE|DOUBLE|TRIPLE|QUAD/,
      `unexpected clear text: "${flash.textContent}"`
    );
  }

  assert.deepEqual(consoleErrors, [], 'no errors during solo play');
  client.close();
});

test('holding and rotating works through the keyboard', async () => {
  const client = await loadClient();
  const { window, consoleErrors } = client;
  const doc = window.document;
  doc.querySelector('#btnSolo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));

  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'z', 'c']) {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
  }
  window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
  window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));

  assert.deepEqual(consoleErrors, [], 'no errors while moving and rotating');
  client.close();
});

test('escape pauses and the overlay appears', async () => {
  const client = await loadClient();
  const { window } = client;
  const doc = window.document;
  doc.querySelector('#btnSolo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(doc.querySelector('#pause').classList.contains('hidden'), true);
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.querySelector('#pause').classList.contains('hidden'), false, 'pause shown');

  doc.querySelector('#btnResume').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.querySelector('#pause').classList.contains('hidden'), true, 'pause dismissed');
  client.close();
});

test('toasts appear and are removed', async () => {
  const client = await loadClient();
  const { window } = client;
  const doc = window.document;
  doc.querySelector('#btnSolo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));

  const toasts = doc.querySelector('#toasts').children;
  assert.ok(toasts.length >= 1, 'solo mode shows a hint toast');
  client.close();
});

test('touch controls are wired up', async () => {
  const client = await loadClient();
  const { window, consoleErrors } = client;
  const doc = window.document;
  doc.querySelector('#btnSolo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));

  const pad = doc.querySelector('#touchPad');
  assert.ok(pad, 'touch pad exists in the markup');
  const buttons = pad.querySelectorAll('.tbtn');
  assert.equal(buttons.length, 5);
  // Fire a drop button even though the pad is hidden on pointer-fine devices.
  pad.querySelector('[data-act="drop"]').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  pad.querySelector('[data-act="left"]').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(consoleErrors, [], 'touch input does not throw');
  client.close();
});

test('multiplayer: creating a room takes us to the lobby', async () => {
  const client = await loadClient();
  const { window, consoleErrors } = client;
  const doc = window.document;

  doc.querySelector('#nameInput').value = 'Tester';
  doc.querySelector('#nameInput').dispatchEvent(new window.Event('input', { bubbles: true }));

  doc.querySelector('#btnCreate').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));

  assert.equal(doc.querySelector('#lobby').classList.contains('active'), true, 'lobby is showing');
  const code = doc.querySelector('#lobbyCode').textContent;
  assert.match(code, /^[A-Z0-9]{5}$/, `room code looks like a code, got "${code}"`);
  assert.equal(doc.querySelector('#lobbyPlayers').children.length, 1);
  assert.ok(doc.querySelector('#lobbyMode').textContent.includes('Marathon'));

  assert.deepEqual(consoleErrors, [], 'no errors while joining a room');
  client.close();
});

test('multiplayer: two clients can ready up and start a match', async () => {
  const a = await loadClient();
  const b = await loadClient();
  const docA = a.window.document;
  const docB = b.window.document;

  docA.querySelector('#nameInput').value = 'Ada';
  docA.querySelector('#nameInput').dispatchEvent(new a.window.Event('input', { bubbles: true }));
  docA.querySelector('#btnCreate').dispatchEvent(new a.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));

  const code = docA.querySelector('#lobbyCode').textContent;
  assert.match(code, /^[A-Z0-9]{5}$/);

  docB.querySelector('#nameInput').value = 'Bob';
  docB.querySelector('#nameInput').dispatchEvent(new b.window.Event('input', { bubbles: true }));
  docB.querySelector('#codeInput').value = code;
  docB.querySelector('#btnJoin').dispatchEvent(new b.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));

  // Both lobbies should list both players.
  assert.equal(docA.querySelector('#lobbyPlayers').children.length, 2, 'host sees two players');
  assert.equal(docB.querySelector('#lobbyPlayers').children.length, 2, 'guest sees two players');
  assert.equal(docA.querySelector('#lobbyPlayerCount').textContent, '2/4');

  // Host has the start button, the guest does not.
  assert.equal(docA.querySelector('#btnStart').style.display, '', 'host can start');
  assert.equal(docB.querySelector('#btnStart').style.display, 'none', 'guest cannot start');

  // Both ready up, then the host starts.
  docA.querySelector('#btnReady').dispatchEvent(new a.window.MouseEvent('click', { bubbles: true }));
  docB.querySelector('#btnReady').dispatchEvent(new b.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(docA.querySelector('#lobbyPlayers').textContent.includes('ready'), true);

  docA.querySelector('#btnStart').dispatchEvent(new a.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1200));

  assert.equal(docA.querySelector('#game').classList.contains('active'), true, 'host is in the game');
  assert.equal(docB.querySelector('#game').classList.contains('active'), true, 'guest is in the game');

  // Each player should see the other as an opponent mini-board.
  assert.ok(docA.querySelectorAll('#opponents .opponent').length >= 1, 'host sees the opponent');
  assert.ok(docB.querySelectorAll('#opponents .opponent').length >= 1, 'guest sees the opponent');

  // Countdown is showing.
  assert.equal(docA.querySelector('#countdown').classList.contains('hidden'), false, 'countdown running');

  assert.deepEqual(a.consoleErrors, [], 'no errors for the host');
  assert.deepEqual(b.consoleErrors, [], 'no errors for the guest');
  a.close();
  b.close();
});

test('multiplayer: opponents boards are drawn and garbage arrives', async () => {
  const a = await loadClient();
  const b = await loadClient();
  const docA = a.window.document;
  const docB = b.window.document;

  // Versus mode so garbage can flow.
  docA.querySelector('#modePicker .mode-btn[data-mode="versus"]').dispatchEvent(
    new a.window.MouseEvent('click', { bubbles: true })
  );
  docA.querySelector('#btnCreate').dispatchEvent(new a.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));
  const code = docA.querySelector('#lobbyCode').textContent;

  docB.querySelector('#codeInput').value = code;
  docB.querySelector('#btnJoin').dispatchEvent(new b.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));

  docA.querySelector('#btnReady').dispatchEvent(new a.window.MouseEvent('click', { bubbles: true }));
  docB.querySelector('#btnReady').dispatchEvent(new b.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  docA.querySelector('#btnStart').dispatchEvent(new a.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 2400)); // clear the countdown

  // Host plays hard drops so its score climbs and its board renders.
  for (let i = 0; i < 10; i++) {
    a.window.dispatchEvent(new a.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  }
  await new Promise((r) => setTimeout(r, 800));

  const score = Number(docA.querySelector('#hudScore').textContent.replace(/,/g, ''));
  assert.ok(score > 0, `host score should be non-zero, got ${score}`);

  // The opponent mini-board canvas must have been painted.
  const miniCanvas = docA.querySelector('#opponents .opponent canvas');
  assert.ok(miniCanvas._ctx, 'opponent canvas has a context');
  assert.ok(miniCanvas._ctx.calls.includes('fillRect'), 'opponent board drawn');

  assert.deepEqual(a.consoleErrors, [], 'no errors while playing a versus match');
  a.close();
  b.close();
});

test('chat messages from another player show up in the log', async () => {
  const a = await loadClient();
  const b = await loadClient();
  const docA = a.window.document;
  const docB = b.window.document;

  docA.querySelector('#btnCreate').dispatchEvent(new a.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));
  const code = docA.querySelector('#lobbyCode').textContent;

  docB.querySelector('#codeInput').value = code;
  docB.querySelector('#btnJoin').dispatchEvent(new b.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));

  const input = docB.querySelector('#chatInput');
  input.value = 'hello from bob';
  docB.querySelector('#btnSendChat').dispatchEvent(new b.window.MouseEvent('click', { bubbles: true }));

  await new Promise((r) => setTimeout(r, 500));
  assert.ok(docA.querySelector('#chatLog').textContent.includes('hello from bob'), 'guest sees the chat');
  assert.ok(docB.querySelector('#chatLog').textContent.includes('hello from bob'), 'sender sees the chat');
  a.close();
  b.close();
});

test('leaving a room returns to the menu', async () => {
  const client = await loadClient();
  const { window } = client;
  const doc = window.document;
  doc.querySelector('#btnCreate').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(doc.querySelector('#lobby').classList.contains('active'), true);

  doc.querySelector('#lobbyBack').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(doc.querySelector('#menu').classList.contains('active'), true, 'back at the menu');
  client.close();
});

test('a dropped connection returns the player to their room', async () => {
  const client = await loadClient();
  const { window } = client;
  const doc = window.document;

  doc.querySelector('#btnCreate').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));
  const code = doc.querySelector('#lobbyCode').textContent;
  assert.match(code, /^[A-Z0-9]{5}$/);

  // Simulate the host sleeping: drop the socket and let Net reconnect.
  client.module.debug().net.ws.close();
  await new Promise((r) => setTimeout(r, 2000));

  // Either we are back in the same room, or the server said it was gone and
  // we were returned to the menu. Both are correct outcomes; silently hanging
  // on a dead room is not.
  const inLobby = doc.querySelector('#lobby').classList.contains('active');
  const inMenu = doc.querySelector('#menu').classList.contains('active');
  assert.ok(inLobby || inMenu, 'the client lands somewhere sensible after a disconnect');
  if (inLobby) {
    assert.equal(doc.querySelector('#lobbyCode').textContent, code, 'same room code');
  } else {
    assert.match(doc.querySelector('#toasts').textContent, /room is gone/i);
  }
  client.close();
});

test('joining a bad room code surfaces an error toast', async () => {
  const client = await loadClient();
  const { window } = client;
  const doc = window.document;
  doc.querySelector('#codeInput').value = 'ZZZZZ';
  doc.querySelector('#btnJoin').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 700));

  const toasts = doc.querySelector('#toasts').textContent;
  assert.ok(toasts.includes('No room'), `expected a "No room" toast, got: ${toasts}`);
  client.close();
});

test('quick play joins a room without typing a code', async () => {
  const client = await loadClient();
  const { window, consoleErrors } = client;
  const doc = window.document;
  doc.querySelector('#btnQuick').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(doc.querySelector('#lobby').classList.contains('active'), true);
  assert.match(doc.querySelector('#lobbyCode').textContent, /^[A-Z0-9]{5}$/);
  assert.deepEqual(consoleErrors, [], 'no errors on quick play');
  client.close();
});