/**
 * Shared message vocabulary between client and server.
 * Keeping it in one file stops the two sides from drifting apart.
 */

export const MSG = {
  // client -> server
  JOIN: 'join',
  QUICK_PLAY: 'quickPlay',
  LIST_ROOMS: 'listRooms',
  LEAVE: 'leave',
  SET_READY: 'setReady',
  SET_SETTINGS: 'setSettings',
  START: 'start',
  INPUT: 'input',
  CHAT: 'chat',
  PING: 'ping',
  REMATCH: 'rematch',

  // server -> client
  HELLO: 'hello',
  ROOM_STATE: 'roomState', // lobby updates and, during a match, board snapshots
  ROOM_LIST: 'roomList',
  GAME_START: 'gameStart',
  GAME_OVER: 'gameOver',
  ERROR: 'error',
  PONG: 'pong',
  LEFT: 'left',
};

/** Room settings a host can tweak before a match. */
export const DEFAULT_SETTINGS = {
  mode: 'marathon', // marathon | sprint | versus
  startingLevel: 1,
  linesToWin: 40, // sprint only
  garbage: true, // versus only
  private: false,
  allowSpectators: true,
  maxPlayers: 4,
};

export const MODE_INFO = {
  marathon: { label: 'Marathon', blurb: 'Clear as many lines as you can. Highest score wins.' },
  sprint: { label: 'Sprint', blurb: 'Race to clear 40 lines. Fastest time wins.' },
  versus: { label: 'Versus', blurb: 'Send garbage to your rivals. Last one standing wins.' },
};