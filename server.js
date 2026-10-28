const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');
const { connectSerial } = require('./hardware/serial');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_GAME_DURATION_MS = 10 * 60 * 1000;
const MAX_GAME_DURATION_MINUTES = 60;
const START_COUNTDOWN_MS = 3 * 1000;
const configuredPenaltySeconds = Number(process.env.WRONG_EVENT_PENALTY_SECONDS);
const WRONG_EVENT_PENALTY_SECONDS = Number.isFinite(configuredPenaltySeconds) && configuredPenaltySeconds > 0
  ? configuredPenaltySeconds
  : 30;
const WRONG_EVENT_PENALTY_MS = WRONG_EVENT_PENALTY_SECONDS * 1000;
const WARNING_DURATION_MS = 6000;
const TICK_INTERVAL_MS = 250;
const STATES = Object.freeze(['IDLE', 'COUNTDOWN', 'MATRIX_STAGE', 'WIRE_STAGE', 'SUCCESS', 'FAILURE']);
const MATRIX_CHANNEL_EVENTS = Object.freeze({
  CHANNEL_D2_D8_ONLINE: { index: 0, online: true },
  CHANNEL_D2_D8_OFFLINE: { index: 0, online: false },
  CHANNEL_D3_D6_ONLINE: { index: 1, online: true },
  CHANNEL_D3_D6_OFFLINE: { index: 1, online: false },
  CHANNEL_D4_D7_ONLINE: { index: 2, online: true },
  CHANNEL_D4_D7_OFFLINE: { index: 2, online: false },
});

let game = createInitialGame();
let nextWarningId = 0;

function createInitialGame() {
  return {
    state: 'IDLE',
    channels: [false, false, false],
    deadline: null,
    countdownDeadline: null,
    roundDurationMs: DEFAULT_GAME_DURATION_MS,
    warning: null,
    message: 'AWAITING GAME MASTER AUTHORIZATION',
    updatedAt: Date.now(),
  };
}

function logEvent(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function getState(now = Date.now()) {
  const remainingMs = game.state === 'COUNTDOWN'
    ? Math.max(0, (game.countdownDeadline || now) - now)
    : ['MATRIX_STAGE', 'WIRE_STAGE'].includes(game.state)
      ? Math.max(0, (game.deadline || now) - now)
      : 0;

  return {
    state: game.state,
    channels: [...game.channels],
    remainingMs,
    warning: game.warning && game.warning.expiresAt > now ? game.warning.text : null,
    message: game.message,
    updatedAt: game.updatedAt,
  };
}

function broadcastState() {
  const payload = JSON.stringify({ type: 'state', state: getState() });
  for (const client of webSocketServer.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

function setGameState(state, message) {
  const previousState = game.state;
  game.state = state;
  game.message = message;
  game.updatedAt = Date.now();
  game.warning = null;
  logEvent(`STATE ${previousState} -> ${state}: ${message}`);
  broadcastState();
}

function showWarning(text) {
  game.warning = { id: ++nextWarningId, text, expiresAt: Date.now() + WARNING_DURATION_MS };
  game.updatedAt = Date.now();
  logEvent(`WARNING ${text}`);
  broadcastState();
}

function handleHardwareEvent(event, options = {}) {
  if (typeof event !== 'string') {
    logEvent(`IGNORED invalid event: ${String(event)}`);
    return;
  }

  const normalizedEvent = event.trim().toUpperCase();
  const activeStates = ['MATRIX_STAGE', 'WIRE_STAGE'];
  const channelEvent = MATRIX_CHANNEL_EVENTS[normalizedEvent];

  if (channelEvent) {
    if (game.state !== 'MATRIX_STAGE') return logEvent(`IGNORED ${normalizedEvent} in ${game.state}`);
    if (game.channels[channelEvent.index] === channelEvent.online) {
      return logEvent(`IGNORED duplicate ${normalizedEvent} in ${game.state}`);
    }
    game.channels[channelEvent.index] = channelEvent.online;
    game.updatedAt = Date.now();
    logEvent(`CHANNEL ${channelEvent.index + 1} ${channelEvent.online ? 'ONLINE' : 'OFFLINE'}: ${normalizedEvent}`);
    broadcastState();
    return;
  }

  switch (normalizedEvent) {
    case 'START':
      if (game.state !== 'IDLE') return logEvent(`IGNORED ${normalizedEvent} in ${game.state}`);
      if (options.durationMinutes !== undefined && (!Number.isInteger(options.durationMinutes)
        || options.durationMinutes < 1
        || options.durationMinutes > MAX_GAME_DURATION_MINUTES)) {
        return logEvent(`IGNORED ${normalizedEvent} with invalid round duration: ${String(options.durationMinutes)}`);
      }
      game.roundDurationMs = options.durationMinutes === undefined
        ? DEFAULT_GAME_DURATION_MS
        : options.durationMinutes * 60 * 1000;
      game.deadline = null;
      game.countdownDeadline = Date.now() + START_COUNTDOWN_MS;
      setGameState('COUNTDOWN', `${game.roundDurationMs / 60000} MINUTE ROUND ARMING`);
      break;
    case 'RESET': {
      const previousState = game.state;
      game = createInitialGame();
      logEvent(`STATE ${previousState} -> IDLE: GAME RESET`);
      broadcastState();
      break;
    }
    case 'MATRIX_VERIFIED':
      if (game.state !== 'MATRIX_STAGE') return logEvent(`IGNORED ${normalizedEvent} in ${game.state}`);
      game.channels = [true, true, true];
      setGameState('WIRE_STAGE', 'CONTROL MATRIX VERIFIED - DISCONNECT CIRCUIT D5');
      break;
    case 'WIRE_CUT':
      if (game.state !== 'WIRE_STAGE') return logEvent(`IGNORED ${normalizedEvent} in ${game.state}`);
      game.deadline = null;
      setGameState('SUCCESS', 'CONTAINMENT STABILIZED');
      break;
    case 'ADD_TIME':
      if (!activeStates.includes(game.state)) return logEvent(`IGNORED ${normalizedEvent} in ${game.state}`);
      game.deadline += WRONG_EVENT_PENALTY_MS;
      game.updatedAt = Date.now();
      logEvent('TIME +30 SECONDS');
      broadcastState();
      break;
    case 'SUBTRACT_TIME':
      if (!activeStates.includes(game.state)) return logEvent(`IGNORED ${normalizedEvent} in ${game.state}`);
      game.deadline -= WRONG_EVENT_PENALTY_MS;
      game.updatedAt = Date.now();
      logEvent('TIME -30 SECONDS');
      if (game.deadline <= Date.now()) {
        game.deadline = null;
        setGameState('FAILURE', 'CONTAINMENT FAILURE - TIME EXPIRED');
      } else {
        broadcastState();
      }
      break;
    case 'FORCE_SUCCESS':
      if (!['COUNTDOWN', ...activeStates].includes(game.state)) return logEvent(`IGNORED ${normalizedEvent} in ${game.state}`);
      game.deadline = null;
      game.countdownDeadline = null;
      setGameState('SUCCESS', 'CONTAINMENT STABILIZED');
      break;
    case 'FORCE_FAILURE':
      if (!['COUNTDOWN', ...activeStates].includes(game.state)) return logEvent(`IGNORED ${normalizedEvent} in ${game.state}`);
      game.deadline = null;
      game.countdownDeadline = null;
      setGameState('FAILURE', 'CONTAINMENT FAILURE');
      break;
    default:
      logEvent(`IGNORED unknown event: ${normalizedEvent || '(empty)'}`);
  }
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
};

const server = http.createServer((request, response) => {
  const requestPath = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
  let filePath;

  try {
    const decodedPath = decodeURIComponent(requestPath);
    filePath = path.resolve(PUBLIC_DIR, `.${decodedPath === '/' ? '/index.html' : decodedPath}`);
    if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) throw new Error('Path outside public directory');
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      const status = error.code === 'ENOENT' ? 404 : 500;
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(status === 404 ? 'Not found' : 'Server error');
      return;
    }

    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(contents);
  });
});

const webSocketServer = new WebSocketServer({ server });

webSocketServer.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'state', state: getState() }));
  socket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type === 'event') handleHardwareEvent(message.event, message);
      else logEvent(`IGNORED unknown WebSocket message type: ${String(message.type)}`);
    } catch {
      logEvent('IGNORED invalid WebSocket message');
    }
  });
});

setInterval(() => {
  const now = Date.now();
  if (game.warning && game.warning.expiresAt <= now) {
    game.warning = null;
    game.updatedAt = now;
    broadcastState();
  }

  if (game.state === 'COUNTDOWN' && game.countdownDeadline <= now) {
    game.countdownDeadline = null;
    game.deadline = now + game.roundDurationMs;
      setGameState('MATRIX_STAGE', 'CONTROL MATRIX OFFLINE - RECONSTRUCT CONTROL MATRIX');
    } else if (['MATRIX_STAGE', 'WIRE_STAGE'].includes(game.state) && game.deadline <= now) {
    game.deadline = null;
    setGameState('FAILURE', 'CONTAINMENT FAILURE - TIME EXPIRED');
  } else if (['COUNTDOWN', 'MATRIX_STAGE', 'WIRE_STAGE'].includes(game.state)) {
    broadcastState();
  }
}, TICK_INTERVAL_MS);

if (require.main === module) {
  logEvent('STATE IDLE: AWAITING GAME MASTER AUTHORIZATION');
  logEvent('CONTROL MATRIX MAP: D2 -> D8 | D3 -> D6 | D4 -> D7');
  logEvent('CUT CIRCUIT: D5 -> CUT WIRE -> GND');
  const serialPath = process.env.SERIAL_PORT?.trim();

  if (!serialPath) {
    logEvent('Hardware serial disabled - running in simulation mode');
  } else {
    const configuredBaudRate = process.env.SERIAL_BAUD === undefined ? 9600 : Number(process.env.SERIAL_BAUD);
    const baudRate = Number.isInteger(configuredBaudRate) && configuredBaudRate > 0 ? configuredBaudRate : 9600;

    if (baudRate !== configuredBaudRate) logEvent('Invalid SERIAL_BAUD; using 9600');

    try {
      const serialConnection = connectSerial({ path: serialPath, baudRate, onEvent: handleHardwareEvent });
      server.once('close', () => serialConnection.close());
    } catch (error) {
      logEvent(`[ARDUINO] unable to initialize serial: ${error.message}`);
      logEvent('Game Master controls remain available in simulation mode');
    }
  }

  server.listen(PORT, '0.0.0.0', () => logEvent(`HTTP and WebSocket server listening on http://localhost:${PORT}`));
}

module.exports = { handleHardwareEvent, getState, server };