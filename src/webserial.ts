/* global SerialPort, ParityType, FlowControlType */

import { sleep } from "./util";
/**
 * Options for device serialPort.
 * @interface SerialOptions
 *
 * Note: According to the documentation of the Web Serial API, 'baudRate' is a
 * 'required' field as part of serial options. However, we are currently
 * maintaining 'baudRate' as a separate parameter outside the options
 * dictionary, and it is effectively used in the code. For now, we are
 * keeping it optional in the dictionary to avoid conflicts.
 */
export interface SerialOptions {
  /**
   * A positive, non-zero value indicating the baud rate at which serial communication should be established.
   * @type {number | undefined}
   */
  baudRate?: number | undefined;

  /**
   * The number of data bits per frame. Either 7 or 8.
   * @type {number | undefined}
   */
  dataBits?: 7 | 8 | undefined;

  /**
   * The number of stop bits at the end of a frame. Either 1 or 2.
   * @type {number | undefined}
   */
  stopBits?: 1 | 2 | undefined;

  /**
   * The parity mode: none, even or odd
   * @type {ParityType | undefined}
   */
  parity?: ParityType | undefined;

  /**
   * A positive, non-zero value indicating the size of the read and write buffers that should be created.
   * @type {number | undefined}
   */
  bufferSize?: number | undefined;

  /**
   * The flow control mode: none or hardware.
   * @type {FlowControlType | undefined}
   */
  flowControl?: FlowControlType | undefined;
}

/**
 * Wrapper class around Webserial API to communicate with the serial device.
 * @param {typeof import("w3c-web-serial").SerialPort} device - Requested device prompted by the browser.
 *
 * ```
 * const port = await navigator.serial.requestPort();
 * ```
 */
class Transport {
  public slipReaderEnabled = false;
  public baudrate = 0;
  private traceLog = "";
  private lastTraceTime = Date.now();
  private buffer: Uint8Array = new Uint8Array(0);
  private onDeviceLostCallback: (() => void) | null = null;
  private reader: (ReadableStreamDefaultReader<Uint8Array> | undefined) = undefined;

  constructor(public device: SerialPort, public tracing = false, enableSlipReader = true) {
    this.slipReaderEnabled = enableSlipReader;
  }

  /**
   * Set callback for when device is lost
   * @param {Function} callback Function to call when device is lost
   */
  setDeviceLostCallback(callback: (() => void) | null) {
    this.onDeviceLostCallback = callback;
  }

  /**
   * Update the device reference (used when re-selecting device after reset)
   * @param {typeof import("w3c-web-serial").SerialPort} newDevice New SerialPort device
   */
  updateDevice(newDevice: SerialPort) {
    this.device = newDevice;
    this.trace("Device reference updated");
  }

  /**
   * Request the serial device vendor ID and Product ID as string.
   * @returns {string} Return the device VendorID and ProductID from SerialPortInfo as formatted string.
   */
  getInfo(): string {
    const info = this.device.getInfo();
    return info.usbVendorId && info.usbProductId
      ? `WebSerial VendorID 0x${info.usbVendorId.toString(16)} ProductID 0x${info.usbProductId.toString(16)}`
      : "";
  }

  /**
   * Request the serial device product id from SerialPortInfo.
   * @returns {number | undefined} Return the product ID.
   */
  getPid(): number | undefined {
    return this.device.getInfo().usbProductId;
  }

  /**
   * Format received or sent data for tracing output.
   * @param {string} message Message to format as trace line.
   */
  trace(message: string) {
    const delta = Date.now() - this.lastTraceTime;
    const prefix = `TRACE ${delta.toFixed(3)}`;
    const traceMessage = `${prefix} ${message}`;
    console.log(traceMessage);
    this.traceLog += traceMessage + "\n";
  }

  async returnTrace() {
    try {
      await navigator.clipboard.writeText(this.traceLog);
      console.log("Text copied to clipboard!");
    } catch (err) {
      console.error("Failed to copy text:", err);
    }
  }

  hexify(s: Uint8Array) {
    return Array.from(s)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .padEnd(16, " ");
  }

  hexConvert(uint8Array: Uint8Array, autoSplit = true) {
    if (autoSplit && uint8Array.length > 16) {
      let result = "";
      let s = uint8Array;

      while (s.length > 0) {
        const line = s.slice(0, 16);
        const asciiLine = String.fromCharCode(...line)
          .split("")
          .map((c) => (c === " " || (c >= " " && c <= "~" && c !== "  ") ? c : "."))
          .join("");
        s = s.slice(16);
        result += `\n    ${this.hexify(line.slice(0, 8))} ${this.hexify(line.slice(8))} | ${asciiLine}`;
      }

      return result;
    } else {
      return this.hexify(uint8Array);
    }
  }

  /**
   * Format data packet using the Serial Line Internet Protocol (SLIP).
   * @param {Uint8Array} data Binary unsigned 8 bit array data to format.
   * @returns {Uint8Array} Formatted unsigned 8 bit data array.
   */
  slipWriter(data: Uint8Array) {
    const outData = [];
    outData.push(0xc0);
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0xdb) {
        outData.push(0xdb, 0xdd);
      } else if (data[i] === 0xc0) {
        outData.push(0xdb, 0xdc);
      } else {
        outData.push(data[i]);
      }
    }
    outData.push(0xc0);
    return new Uint8Array(outData);
  }

  /**
   * Write binary data to device using the WebSerial device writable stream.
   * @param {Uint8Array} data 8 bit unsigned data array to write to device.
   */
  async write(data: Uint8Array) {
    const outData = this.slipWriter(data);

    if (this.device.writable) {
      const writer = this.device.writable.getWriter();
      if (this.tracing) {
        this.trace(`Write ${outData.length} bytes: ${this.hexConvert(outData)}`);
      }
      await writer.write(outData);
      writer.releaseLock();
    }
  }

  /**
   * Append a buffer array after another buffer array
   * @param {Uint8Array} arr1 - First array buffer.
   * @param {Uint8Array} arr2 - magic hex number to select ROM.
   * @returns {Uint8Array} Return a 8 bit unsigned array.
   */
  appendArray(arr1: Uint8Array, arr2: Uint8Array): Uint8Array {
    const combined = new Uint8Array(arr1.length + arr2.length);
    combined.set(arr1);
    combined.set(arr2, arr1.length);
    return combined;
  }

  /**
   * Read from serial device with a timeout
   * @param {number} milliseconds to wait
   * @returns {Uint8Array} data, or empty array on timeout
   * @throw {Error | TypeError} Any unrecoverable situation throws an error
   */
  async timedRead(timeout: number): Promise<Uint8Array> {
    while (this.device.readable) {
      try {
        this.reader = this.device.readable.getReader();
        const timer = setTimeout(() => { this.reader?.releaseLock(); }, timeout);
        const { value, done } = await this.reader.read();
        clearTimeout(timer);
        this.reader.releaseLock();

        if (done) {
          throw new Error("Serial port closed");
        }
        // We do not expect value.length to be 0 because
        // read() only returns when it has data.
        if (this.tracing) {
            console.log("Timed Read bytes");
            this.trace(`Read ${value.length} bytes: ${this.hexConvert(value)}`);
        }
        return value;
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === 'Releasing Default reader') {
            // Timeout; return empty buffer
            break;
          }
          const nonFatal = [ 'BufferOverrunError', 'FramingError', 'BreakError', 'ParityError' ];
          if (nonFatal.includes(error.name)) {
            // Retry on non-fatal errors
            continue;
          }
          if (error.name === "NetworkError" && error.message.includes("device has been lost")) {
            this.trace("Device lost detected (NetworkError)");
            if (this.onDeviceLostCallback) {
              // The callback can choose to throw an error or not
              this.onDeviceLostCallback();
            } else {
              throw error;
            }
          }

        }
        // Probably port disconnected or something like that
        console.error("Serial port error:", error);
        throw error;
       }
    }
    throw new Error("Serial port closed");
  }

  /*
   * Gets the next byte from the buffer or the serial port
   */
  async nextByte(timeout: number): Promise<number | undefined> {
    if (this.buffer.length === 0) {
      const readBytes = await this.timedRead(timeout);
      if (readBytes.length === 0) {
        return undefined;
      }
      this.trace(`Read ${readBytes.length} bytes: ${this.hexConvert(readBytes)}`);
      this.buffer = readBytes;
    }

    const result = this.buffer[0];
    this.buffer = this.buffer.subarray(1);
    return result;
  }

  private residue(): Uint8Array | undefined {
    if (!this.buffer.length) {
      return undefined;
    }
    const result = this.buffer;
    this.buffer = new Uint8Array(0);
    return result;
  }

  flushInput() {
    this.buffer = new Uint8Array(0);
  }

  async flushOutput() {
    try {
      if (this.device.writable) {
        const writer = this.device.writable.getWriter();
        await writer.close();
        writer.releaseLock();
      }
    } catch (error) {
      this.trace(`Error while flushing output: ${error}`);
    }
  }

  /**
   * Detect if the data read from device is a Fatal or Guru meditation error.
   * @param {Uint8Array} input Data read from device
   */
  private detectPanicHandler(input: Uint8Array) {
    const guruMeditationRegex = /G?uru Meditation Error: (?:Core \d panic'ed \(([a-zA-Z ]*)\))?/;
    const fatalExceptionRegex = /F?atal exception \(\d+\): (?:([a-zA-Z ]*)?.*epc)?/;

    const inputString = new TextDecoder("utf-8").decode(input);
    const match = inputString.match(guruMeditationRegex) || inputString.match(fatalExceptionRegex);

    if (match) {
      const cause = match[1] || match[2];
      const msg = `Guru Meditation Error detected${cause ? ` (${cause})` : ""}`;
      throw new Error(msg);
    }
  }

  async readLine(timeout: number): Promise<string> {
    let line: string = "";
    while (true) {
      const byte = await this.nextByte(timeout);
      if (byte === undefined) {
        throw new Error("Timeout");
      }
      if (byte == 0x0d) { // carriage return
        continue;
      }
      if (byte == 0x0a) { // newline
        const result = line;
        line = "";
        return result;
      }
      line += String.fromCharCode(byte);
    }
  }

  private SLIP_END = 0xc0;
  private SLIP_ESC = 0xdb;
  private SLIP_ESC_END = 0xdc;
  private SLIP_ESC_ESC = 0xdd;

  /**
   * Take a data array and return the first well formed packet after
   * replacing the escape sequence. Reads at least 8 bytes.
   * @param {number} timeout Timeout read data.
   * @returns {Uint8Array} Formatted packet using SLIP escape sequences.
   */
  async read(timeout: number): Promise<Uint8Array> {
    let partialPacket: Uint8Array | null = null;
    let isEscaping = false;
    let successfulSlip = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const byte = await this.nextByte(timeout);
      if (byte === undefined) {
         const msg =
           partialPacket === null
          ? successfulSlip
          ? "Serial data stream stopped: Possible serial noise or corruption."
          : "No serial data received."
        : `Packet content transfer stopped`;
         this.trace(msg);
         throw new Error(msg);
       }
      if (partialPacket === null) {
        if (byte === this.SLIP_END) {
          partialPacket = new Uint8Array(0); // Start of a new packet
        } else {
          this.trace(`Read invalid data: ${this.hexConvert(new Uint8Array([byte]))}`);
          const remainingData = await this.timedRead(timeout);
          if (remainingData.length) {
            this.trace(`Remaining data in serial buffer: ${this.hexConvert(remainingData)}`);
            this.detectPanicHandler(new Uint8Array([...new Uint8Array([byte]), ...(remainingData || [])]));
          }
          throw new Error(`Invalid head of packet (0x${byte.toString(16)}): Possible serial noise or corruption.`);
        }
      } else if (isEscaping) {
        isEscaping = false;
        if (byte === this.SLIP_ESC_END) {
          partialPacket = this.appendArray(partialPacket, new Uint8Array([this.SLIP_END]));
        } else if (byte === this.SLIP_ESC_ESC) {
          partialPacket = this.appendArray(partialPacket, new Uint8Array([this.SLIP_ESC]));
        } else {
          this.trace(`Read invalid data: ${new Uint8Array([byte])}`);
          const remainingData = this.residue();
          if (remainingData !== undefined) {
             this.trace(`Remaining data in serial buffer: ${this.hexConvert(remainingData)}`);
            this.detectPanicHandler(new Uint8Array([...new Uint8Array([byte]), ...(remainingData || [])]));
           }
          throw new Error(`Invalid SLIP escape (0xdb, 0x${byte.toString(16)})`);
         }
      } else if (byte === this.SLIP_ESC) {
        isEscaping = true;
      } else if (byte === this.SLIP_END) {
        this.trace(`Received full packet: ${this.hexConvert(partialPacket)}`);
        return partialPacket;
        partialPacket = null;
        successfulSlip = true;
      } else {
        partialPacket = this.appendArray(partialPacket, new Uint8Array([byte]));
       }
    }
  }


  _DTR_state = false;
  /**
   * Send the RequestToSend (RTS) signal to given state
   * # True for EN=LOW, chip in reset and False EN=HIGH, chip out of reset
   * @param {boolean} state Boolean state to set the signal
   */
  async setRTS(state: boolean) {
    await this.device.setSignals({ requestToSend: state });
    // # Work-around for adapters on Windows using the usbser.sys driver:
    // # generate a dummy change to DTR so that the set-control-line-state
    // # request is sent with the updated RTS state and the same DTR state
    // Referenced to esptool.py
    await this.setDTR(this._DTR_state);
  }

  /**
   * Send the dataTerminalReady (DTS) signal to given state
   * # True for IO0=LOW, chip in reset and False IO0=HIGH
   * @param {boolean} state Boolean state to set the signal
   */
  async setDTR(state: boolean) {
    this._DTR_state = state;
    await this.device.setSignals({ dataTerminalReady: state });
  }

  /**
   * Set RTS and DTR in a single call to WebSerial, thus
   * avoiding timing uncertainty.
   * # True for LOW, false HIGH
   * @param {boolean} rts - State for RTS
   * @param {boolean} dtr - State for DTR
   */
  async setRtsDtr(rts: boolean, dtr: boolean) {
    this._DTR_state = dtr;
    await this.device.setSignals({ requestToSend: rts, dataTerminalReady: dtr });
  }

  /**
   * Connect to serial device using the Webserial open method.
   * @param {number} baud Number baud rate for serial connection. Default is 115200.
   * @param {typeof import("w3c-web-serial").SerialOptions} serialOptions Serial Options for WebUSB SerialPort class.
   */
  async connect(baud = 115200, serialOptions: SerialOptions = {}) {
    await this.device.open({
      baudRate: baud,
      dataBits: serialOptions?.dataBits,
      stopBits: serialOptions?.stopBits,
      bufferSize: serialOptions?.bufferSize,
      parity: serialOptions?.parity,
      flowControl: serialOptions?.flowControl,
    });
    this.baudrate = baud;
  }

  /**
   * Disconnect from serial device by running SerialPort.close() after streams unlock.
   */
  async disconnect() {
    while (this.device.readable?.locked) {
      this.reader?.cancel();
      await sleep(10);
    }
    while (this.device.writable?.locked) {
      await sleep(10);
    }
    await this.device.close();
  }
}

export { Transport };
