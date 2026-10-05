# Blockfall

Online multiplayer Tetris with rooms. Play solo on your own machine, or spin up
a room and race friends over the internet.

The game rules live in one shared module that both the browser and the server
run, so a cheat client cannot disagree with the simulation.

```
┌─────────────┐   WebSocket /ws    ┌──────────────────────┐
│  browser    │ ─────────────────► │  Node server          │
│  public/    │ ◄───────────────── │  server/index.js      │
│             │   20 board updates │  server/rooms.js      │
│  predicts   │   per second       │  authoritative sim     │
└─────────────┘                    └──────────────────────┘
       │                                    │
       └────────── src/core/game.js ────────┘  one rules engine, both sides
```

## Quick start

```bash
npm install
npm start          # http://localhost:8080
```

Then open <http://localhost:8080>, pick **Solo** to play immediately, or
**New room** to create a room and share the code.

There is no build step. The server serves the static client and the WebSocket
endpoint from the same process, so one command is the whole thing.

## Controls

| Key | Action |
| --- | --- |
| <kbd>←</kbd> <kbd>→</kbd> | Move (hold to auto-shift) |
| <kbd>↓</kbd> | Soft drop |
| <kbd>Space</kbd> | Hard drop |
| <kbd>↑</kbd> / <kbd>X</kbd> | Rotate clockwise |
| <kbd>Z</kbd> | Rotate counter-clockwise |
| <kbd>C</kbd> / <kbd>Shift</kbd> | Hold piece |
| <kbd>Esc</kbd> | Pause |

Touch controls appear automatically on phones and tablets.

## Game modes

- **Marathon** &mdash; clear as many lines as you can, highest score wins.
- **Sprint** &mdash; race to a line goal (40 by default), fastest time wins.
- **Versus** &mdash; clear lines to send garbage to your rivals, last player
  standing wins. Quad and T-spins deal the most damage.

## How rooms work

- Anyone can create a room and gets a 5-character code, e.g. `K7QF2`.
- Share the code, or the **Share invite** button which copies a link with the
  code in the URL fragment.
- Rooms show up in the **Rooms** list on the menu and in **Quick play** (which
  finds an open room of the right mode).
- The host picks the mode and settings, everyone readies up, host starts.
- Mark a room **Private** to keep it out of quick play and the room list.
- After a match, vote for a rematch and it restarts once everyone has voted.
- Empty rooms are cleaned up after a minute.

## Deploying

The client is plain static files and the server is one small Node process, so
there are two useful setups.

### Option 1: one container for everything

Deploy the included `Dockerfile` anywhere that runs containers (Render, Fly.io,
Railway, Cloud Run, your own box).

```bash
docker build -t blockfall .
docker run -p 8080:8080 blockfall
```

On Render the `render.yaml` blueprint is already set up:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/YOUR_USER/blockfall)

### Option 2: static client on GitHub Pages, server elsewhere

`.github/workflows/deploy.yml` publishes `public/` plus the shared engine to
GitHub Pages on every push to `main`. Enable Pages with "GitHub Actions" as the
source.

The client looks for the WebSocket server on its own origin by default. To point
the hosted page at a separate server, set this in the browser console on the
site (it persists in `localStorage`):

```js
localStorage.setItem('blockfall.server', 'https://blockfall.onrender.com');
```

Then reload. GitHub Pages is served over HTTPS, so the client will use `wss://`
automatically.

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port. Most PaaS providers inject this. |
| `HOST` | `0.0.0.0` | Bind address. |
| `NODE_ENV` | &mdash; | Set to `production` in deployment. |

## How multiplayer works

The server owns the truth. It runs the same `src/core/game.js` the client does,
at a fixed 60 ticks per second, and streams each player's board to the room 20
times a second. Clients only send intent (`move left`, `rotate`, `hard drop`).

The client predicts locally so input feels instant. When a snapshot disagrees
with the prediction, the client adopts the server board and replays the inputs
that are probably still in flight, which hides the round trip without the piece
jumping backwards.

Pieces are drawn from a seeded 7-bag randomizer, so a seed reproduces a match
exactly. Board state is packed into one character per cell, which keeps a full
four-player snapshot comfortably under 4 KB.

## Project layout

```
src/core/      Shared rules engine: pieces, SRS kicks, scoring, gravity
server/        Static file host, WebSocket server, room registry
public/        Client: index.html, style.css, js/
test/          Unit, room, T-spin, play, socket and browser tests
```

## Tests

```bash
npm test              # everything
npm run test:unit     # rules engine and room logic only
npm run test:e2e      # real WebSocket clients against a real server
npm run test:client   # the browser client booted in jsdom
```

The suite covers the rules engine (scoring, T-spins, SRS kicks, level curve,
7-bag fairness), room permissions and match lifecycle, two real WebSocket
clients playing a match, and the actual browser client driven through the menu,
lobby and a live versus match.

## Rules and scoring

Standard Tetris Guideline with competitive additions:

- Super Rotation System wall kicks, including a 180 rotation with its own kicks.
- 7-bag randomizer, hold piece, five-piece preview, ghost piece, lock delay.
- T-spin detection with mini/full distinction, perfect clears, combos and
  back-to-back bonuses.
- Gravity follows `(0.8 - (level-1) * 0.007) ^ (level-1)` seconds per row.

| Clear | Points | Garbage sent |
| --- | --- | --- |
| Single | 100 | 0 |
| Double | 300 | 1 |
| Triple | 500 | 2 |
| Quad | 800 | 4 |
| T-spin | 400 | 4 |
| T-spin single | 800 | 8 |
| T-spin double | 1200 | 13 |
| T-spin triple | 1600 | 18 |
| Perfect clear | 800&ndash;2000 | 0&ndash;8 |

Scores are multiplied by level; back-to-back difficult clears and combo streaks
add more. Values live in `src/core/scoring.js` if you want to tune them.

## License

MIT. See [LICENSE](LICENSE).