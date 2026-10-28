const connectionLabel = document.getElementById('connection-label');
const warningBanner = document.getElementById('warning-banner');
const gmPanel = document.getElementById('gm-panel');
const gmState = document.getElementById('gm-state');
const roundDurationInput = document.getElementById('round-duration');
const terminal = document.getElementById('terminal');
let socket;
let reconnectTimer;
let lastWarning = null;
let lastAuthoritativeState = null;
let transitionTimer;
let currentState = { state: 'IDLE', remainingMs: 0 };

const elements = {
  headline: document.getElementById('headline'),
  subheadline: document.getElementById('subheadline'),
  timer: document.getElementById('timer'),
  timerCaption: document.getElementById('timer-caption'),
  timerUnit: document.getElementById('timer-unit'),
  phaseLabel: document.getElementById('phase-label'),
  instruction: document.getElementById('instruction-text'),
  containment: document.getElementById('containment-value'),
  circuit: document.getElementById('circuit-value'),
  override: document.getElementById('override-value'),
  link: document.getElementById('link-value'),
  circuitConsole: document.getElementById('circuit-console'),
  matrixOverallStatus: document.getElementById('matrix-overall-status'),
  matrixFooter: document.getElementById('matrix-footer'),
  channelStatuses: [1, 2, 3].map((channel) => document.getElementById(`channel-status-${channel}`)),
  d5Board: document.getElementById('d5-board'),
  d5Status: document.getElementById('d5-status'),
  d5Warning: document.getElementById('d5-warning'),
  zone: document.getElementById('zone-label'),
};

function connect() {
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}`);

  socket.addEventListener('open', () => {
    connectionLabel.textContent = 'LINK ACTIVE';
    connectionLabel.parentElement.classList.add('connected');
    elements.link.textContent = 'ONLINE';
    elements.link.className = 'telemetry-value good';
  });

  socket.addEventListener('message', (message) => {
    try {
      const payload = JSON.parse(message.data);
      if (payload.type === 'state') renderState(payload.state, true);
    } catch {
      elements.link.textContent = 'BAD DATA';
      elements.link.className = 'telemetry-value bad';
    }
  });

  socket.addEventListener('close', () => {
    connectionLabel.textContent = 'LINK LOST';
    connectionLabel.parentElement.classList.remove('connected');
    elements.link.textContent = 'RECONNECTING';
    elements.link.className = 'telemetry-value bad';
    reconnectTimer = setTimeout(connect, 1000);
  });

  socket.addEventListener('error', () => socket.close());
}

function formatTime(milliseconds) {
  const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderState(state, authoritative = false) {
  const previousState = authoritative ? lastAuthoritativeState?.state : null;
  const matrixVerifiedNow = previousState === 'MATRIX_STAGE' && state.state === 'WIRE_STAGE';
  const wireCutNow = previousState === 'WIRE_STAGE' && state.state === 'SUCCESS';
  currentState = state;
  const active = ['COUNTDOWN', 'MATRIX_STAGE', 'WIRE_STAGE'].includes(state.state);
  const matrixStage = state.state === 'MATRIX_STAGE';
  const wireStage = state.state === 'WIRE_STAGE';
  const success = state.state === 'SUCCESS';
  const failure = state.state === 'FAILURE';
  const verified = wireStage || success;
  const stateLabels = {
    IDLE: 'SYSTEM STANDBY',
    COUNTDOWN: 'SYSTEM ARMING',
    MATRIX_STAGE: 'CONTROL MATRIX',
    WIRE_STAGE: 'EMERGENCY PROCEDURE',
    SUCCESS: 'CONTAINMENT SECURE',
    FAILURE: 'CONTAINMENT LOST',
  };

  elements.phaseLabel.textContent = stateLabels[state.state] || 'SYSTEM STATUS UNKNOWN';
  elements.zone.textContent = success ? 'SECTOR 22-D' : 'SECTOR 07';
  elements.timer.textContent = active ? formatTime(state.remainingMs) : success ? 'SAFE' : failure ? 'LOST' : '--:--';
  elements.timer.setAttribute('aria-label', active ? `${formatTime(state.remainingMs)} remaining` : state.state);
  elements.timerCaption.textContent = active ? 'TIME TO CONTAINMENT BREACH' : success ? 'BIOHAZARD LEVEL' : failure ? 'BIOHAZARD LEVEL' : 'SYSTEM STATUS';
  elements.timerUnit.textContent = active ? 'MINUTES : SECONDS' : success ? 'STABLE' : failure ? 'CRITICAL' : 'AWAITING START';

  if (state.state === 'IDLE') {
    elements.headline.innerHTML = 'CONTAINMENT<br>ISOLATION SYSTEM';
    elements.subheadline.textContent = 'Awaiting authorized activation';
    elements.instruction.innerHTML = 'MANUAL OVERRIDE REQUIRED<br>AWAITING GAME MASTER AUTHORIZATION';
  } else if (state.state === 'COUNTDOWN') {
    elements.headline.innerHTML = 'CONTAINMENT<br>SYSTEM ARMING';
    elements.subheadline.textContent = 'Emergency protocol initializing';
    elements.instruction.innerHTML = 'STAND BY<br>MANUAL OVERRIDE REQUIRED';
  } else if (matrixStage) {
    elements.headline.innerHTML = 'CONTROL MATRIX<br>OFFLINE';
    elements.subheadline.textContent = 'MANUAL OVERRIDE REQUIRED';
    elements.instruction.innerHTML = 'RECONSTRUCT CONTROL MATRIX<br>CONNECT ALL THREE CONTROL CHANNELS';
  } else if (wireStage) {
    elements.headline.innerHTML = 'EMERGENCY CONTAINMENT<br>PROCEDURE';
    elements.subheadline.textContent = 'CONTROL MATRIX VERIFIED / 3/3 CHANNELS ONLINE';
    elements.instruction.innerHTML = 'IDENTIFY AND DISCONNECT<br>THE DESIGNATED CIRCUIT';
  } else if (success) {
    elements.headline.innerHTML = 'CONTAINMENT<br>RESTORED';
    elements.subheadline.textContent = 'SECTOR 22-D SECURE';
    elements.instruction.innerHTML = 'ACCESS GRANTED<br>CONTAINMENT SYSTEM STABLE';
  } else {
    elements.headline.innerHTML = 'CONTAINMENT<br>FAILURE';
    elements.subheadline.textContent = 'BIOHAZARD BARRIER COMPROMISED';
    elements.instruction.innerHTML = 'EVACUATE THE SECTOR<br>AWAIT FURTHER INSTRUCTIONS';
  }

  elements.containment.textContent = success ? 'STABILIZED' : failure ? 'BREACHED' : active ? 'AT RISK' : 'STANDBY';
  elements.containment.className = `telemetry-value ${success ? 'good' : active || failure ? 'bad' : ''}`;
  elements.circuit.textContent = success ? 'SECURE' : wireStage ? 'CUT TARGET READY' : matrixStage ? 'RECONSTRUCT' : active ? 'AT RISK' : 'OFFLINE';
  elements.circuit.className = `telemetry-value ${success ? 'good' : active ? 'bad' : ''}`;
  elements.override.textContent = success ? 'GRANTED' : active || failure ? 'REQUIRED' : 'LOCKED';
  elements.override.className = `telemetry-value ${success ? 'good' : active || failure ? 'bad' : ''}`;
  terminal.classList.toggle('is-success', success);
  terminal.classList.toggle('is-failure', failure);
  terminal.classList.toggle('is-matrix', matrixStage);
  terminal.classList.toggle('is-wire-stage', wireStage);
  elements.circuitConsole.hidden = !(matrixStage || wireStage || success);
  elements.circuitConsole.classList.toggle('is-verified', verified);
  elements.d5Board.hidden = !(wireStage || success);
  elements.matrixOverallStatus.textContent = matrixStage ? 'OFFLINE' : verified ? 'VERIFIED' : 'OFFLINE';
  elements.matrixFooter.textContent = matrixStage
    ? 'MANUAL OVERRIDE REQUIRED / RECONSTRUCT CONTROL MATRIX'
    : verified ? '3/3 CONTROL CHANNELS ONLINE / CONTROL MATRIX VERIFIED' : 'CONTROL MATRIX OFFLINE';
  elements.channelStatuses.forEach((status) => {
    status.textContent = verified ? 'ONLINE' : 'OFFLINE';
  });
  elements.d5Status.textContent = success ? 'CIRCUIT ISOLATED' : 'LIVE / DANGEROUS';
  elements.d5Warning.textContent = success ? 'CONTAINMENT CIRCUIT OPEN / SAFE' : 'WARNING / LIVE CONTROL CIRCUIT';
  elements.d5Board.classList.toggle('is-cut', success);
  if (matrixVerifiedNow) playTransition('matrix-activation', 1700);
  if (wireCutNow) playTransition('success-impact', 1600);
  gmState.textContent = state.state;

  setProgress('step-1', matrixStage, ['WIRE_STAGE', 'SUCCESS'].includes(state.state));
  setProgress('step-2', wireStage, success);
  setProgress('step-3', success, false);
  document.getElementById('connector-1').classList.toggle('done', ['WIRE_STAGE', 'SUCCESS'].includes(state.state));
  document.getElementById('connector-2').classList.toggle('done', success);

  if (state.warning && state.warning !== lastWarning) {
    warningBanner.textContent = state.warning;
    warningBanner.hidden = false;
    lastWarning = state.warning;
  } else if (!state.warning) {
    warningBanner.hidden = true;
    lastWarning = null;
  }

  document.querySelectorAll('.gm-button').forEach((button) => {
    button.disabled = !socket || socket.readyState !== WebSocket.OPEN;
  });
  roundDurationInput.disabled = !socket || socket.readyState !== WebSocket.OPEN;
  if (authoritative) lastAuthoritativeState = state;
}

function playTransition(className, duration) {
  clearTimeout(transitionTimer);
  terminal.classList.remove('matrix-activation', 'success-impact');
  requestAnimationFrame(() => terminal.classList.add(className));
  transitionTimer = setTimeout(() => terminal.classList.remove(className), duration);
}

function setProgress(id, active, done) {
  const element = document.getElementById(id);
  element.classList.toggle('active', active);
  element.classList.toggle('done', done);
}

function sendEvent(event, details = {}) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'event', event, ...details }));
}

function toggleGameMaster(forceOpen) {
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : gmPanel.hidden;
  gmPanel.hidden = !shouldOpen;
  if (shouldOpen) gmPanel.querySelector('button:not([disabled])')?.focus();
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'F8') {
    event.preventDefault();
    toggleGameMaster();
  } else if (event.key === 'Escape' && !gmPanel.hidden) {
    toggleGameMaster(false);
  }
});

document.querySelectorAll('.gm-button').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.event === 'START') {
      if (!roundDurationInput.reportValidity()) return;
      sendEvent('START', { durationMinutes: roundDurationInput.valueAsNumber });
      toggleGameMaster(false);
      return;
    }

    sendEvent(button.dataset.event);
    toggleGameMaster(false);
  });
});

document.getElementById('gm-close').addEventListener('click', () => toggleGameMaster(false));
document.getElementById('fullscreen-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    document.getElementById('fullscreen-button').title = 'Fullscreen is unavailable in this browser';
  }
});

function updateClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString([], { hour12: false });
}

updateClock();
setInterval(updateClock, 1000);
renderState(currentState);
connect();