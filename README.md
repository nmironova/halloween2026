# Halloween Zombie Quest Terminal

Lightweight Node.js server and browser terminal for the Halloween zombie quest.

## Run in simulation mode

Install dependencies and start the server:

```sh
npm install
npm start
```

Open `http://localhost:3000` and press F8 to open the Game Master controls. If `SERIAL_PORT` is not set, the application runs in simulation mode and the debug controls remain available.

## Hardware mode

When an Arduino Uno is connected, set `SERIAL_PORT` to its serial device. The default baud rate is 9600; optionally set `SERIAL_BAUD` to override it.

macOS:

```sh
SERIAL_PORT=/dev/cu.usbserial-XXXX npm start
```

Windows cmd:

```bat
set SERIAL_PORT=COM3
npm start
```

The serial port name will be determined after the Arduino Uno is connected. Without `SERIAL_PORT`, no serial device is opened and the application stays in simulation mode.