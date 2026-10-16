const { SerialPort, ReadlineParser } = require('serialport');

const RECONNECT_DELAY_MS = 3000;

function logArduino(message) {
  console.log(`[${new Date().toISOString()}] [ARDUINO] ${message}`);
}

function handleSerialLine(line, onEvent) {
  if (typeof line !== 'string') {
    logArduino('ignored malformed non-text message');
    return;
  }

  const event = line.trim();
  if (!event) return;

  logArduino(`<- ${event}`);
  try {
    onEvent(event);
  } catch (error) {
    logArduino(`event handler error: ${error.message}`);
  }
}

function connectSerial({ path, baudRate = 9600, onEvent }) {
  if (typeof path !== 'string' || !path.trim()) throw new TypeError('A serial port path is required');
  if (!Number.isInteger(baudRate) || baudRate < 1) throw new TypeError('Baud rate must be a positive integer');
  if (typeof onEvent !== 'function') throw new TypeError('An onEvent callback is required');

  let activePort = null;
  let reconnectTimer = null;
  let stopped = false;

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openPort();
    }, RECONNECT_DELAY_MS);
    reconnectTimer.unref();
  }

  function openPort() {
    if (stopped || activePort?.isOpen) return;

    const port = new SerialPort({ path, baudRate, autoOpen: false });
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
    let connected = false;
    let reportedOpenError = false;
    activePort = port;

    parser.on('data', (line) => handleSerialLine(line, onEvent));
    parser.on('error', (error) => logArduino(`parser error: ${error.message}`));
    port.on('open', () => {
      connected = true;
      logArduino(`connected: ${path} @ ${baudRate}`);
    });
    port.on('error', (error) => {
      reportedOpenError = true;
      logArduino(`serial error: ${error.message}`);
      if (port.isOpen) {
        port.close((closeError) => {
          if (closeError) logArduino(`close error: ${closeError.message}`);
        });
      } else {
        if (activePort === port) activePort = null;
        scheduleReconnect();
      }
    });
    port.on('close', () => {
      if (activePort === port) activePort = null;
      if (connected) logArduino('disconnected');
      scheduleReconnect();
    });

    port.open((error) => {
      if (!error) return;
      if (!reportedOpenError) logArduino(`unable to open ${path}: ${error.message}`);
      if (activePort === port) activePort = null;
      scheduleReconnect();
    });
  }

  openPort();

  return {
    close() {
      stopped = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (activePort?.isOpen) activePort.close();
      activePort = null;
    },
  };
}

module.exports = { connectSerial, handleSerialLine };