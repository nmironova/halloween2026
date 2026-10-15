const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_GAME_DURATION_MS = 5 * 60 * 1000;
const MAX_GAME_DURATION_MINUTES = 60;
const START_COUNTDOWN_MS = 3 * 1000;
const configuredPenaltySeconds = Number(process.env.WRONG_EVENT_PENALTY_SECONDS);
const WRONG_EVENT_PENALTY_SECONDS = Number.isFinite(configuredPenaltySeconds) && configuredPenaltySeconds > 0
  ? configuredPenaltySeconds
  : 30;
const WRONG_EVENT_PENALTY_MS = WRONG_EVENT_PENALTY_SECONDS * 1000;
const WARNING_DURATION_MS = 6000;
const TICK_INTERVAL_MS = 250;
const STATES = Object.freeze(['IDLE', 'COUNTDOWN', 'WIRE_STAGE', 'PATCH_STAGE', 'SUCCESS', 'FAILURE']);

let game = createInitialGame();
let nextWarningId = 0;

function createInitialGame() {
  return {
    state: 'IDLE',
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
    : ['WIRE_STAGE', 'PATCH_STAGE'].includes(game.state)
      ? Math.max(0, (game.deadline || now) - now)
      : 0;

  return {
    state: game.state,
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
  game.state = state;
  game.message = message;
  game.updatedAt = Date.now();
  game.warning = null;
  logEvent(`STATE ${state}: ${message}`);
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
  const activeStates = ['WIRE_STAGE', 'PATCH_STAGE'];

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
    case 'RESET':
      game = createInitialGame();
      logEvent('STATE IDLE: GAME RESET');
      broadcastState();
      break;
    case 'WIRE_CUT':
      if (game.state !== 'WIRE_STAGE') return logEvent(`IGNORED ${normalizedEvent} in ${game.state}`);
      setGameState('PATCH_STAGE', 'RESTORE THE EMERGENCY PATCH CIRCUIT');
      showWarning('WIRE CUT CONFIRMED - RESTORE EMERGENCY PATCH CIRCUIT');
      break;
    case 'WRONG_A':
    case 'WRONG_C':
      if (!activeStates.includes(game.state)) return logEvent(`IGNORED ${normalizedEvent} in ${game.state}`);
      game.deadline -= WRONG_EVENT_PENALTY_MS;
      game.updatedAt = Date.now();
      showWarning(`${normalizedEvent.replace('_', ' ')} - ${WRONG_EVENT_PENALTY_SECONDS} SECOND PENALTY`);
      break;
    case 'CIRCUIT_RESTORED':
      if (game.state !== 'PATCH_STAGE') return logEvent(`IGNORED ${normalizedEvent} in ${game.state}`);
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
    setGameState('WIRE_STAGE', 'CUT THE DESIGNATED WIRE TO BEGIN THE PATCH');
  } else if (['WIRE_STAGE', 'PATCH_STAGE'].includes(game.state) && game.deadline <= now) {
    game.deadline = null;
    setGameState('FAILURE', 'CONTAINMENT FAILURE - TIME EXPIRED');
  } else if (['COUNTDOWN', 'WIRE_STAGE', 'PATCH_STAGE'].includes(game.state)) {
    broadcastState();
  }
}, TICK_INTERVAL_MS);

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => logEvent(`HTTP and WebSocket server listening on http://localhost:${PORT}`));
}

module.exports = { handleHardwareEvent, getState, server };