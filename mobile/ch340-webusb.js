// A CH340 / CH341 USB-serial adapter (the chip on most CYD boards) driven over WebUSB,
// with the parts of the Web Serial SerialPort that esptool-js uses: open, close,
// readable, writable, setSignals, getInfo. Chrome on Android has WebUSB for wired
// devices but its Web Serial only lists Bluetooth ones.
// Protocol as in Linux drivers/usb/serial/ch341.c and usb-serial-for-android.

export const CH34X_FILTERS = [
  { vendorId: 0x1a86, productId: 0x7523 }, // CH340
  { vendorId: 0x1a86, productId: 0x7522 }, // CH340K
  { vendorId: 0x1a86, productId: 0x5523 }, // CH341
  { vendorId: 0x1a86, productId: 0xe523 }, // CH330
];

const REQ_READ_VERSION = 0x5f;
const REQ_WRITE_REG = 0x9a;
const REQ_SERIAL_INIT = 0xa1;
const REQ_MODEM_CTRL = 0xa4;
const LCR_8N1 = 0x80 | 0x40 | 0x03; // enable RX, enable TX, 8 data bits
const BIT_DTR = 0x20;
const BIT_RTS = 0x40;

export class Ch340Port {
  constructor(device) {
    this.device = device;
    this.readable = null;
    this.writable = null;
    this.dtr = false;
    this.rts = false;
    this.opened = false;
    this.rxBytes = 0;
    this.txBytes = 0;
    this.onLog = null; // (text) => void, for the page's log
  }

  log(t) {
    if (this.onLog) this.onLog(t);
  }

  getInfo() {
    return { usbVendorId: this.device.vendorId, usbProductId: this.device.productId };
  }

  async ctrlOut(request, value = 0, index = 0) {
    const r = await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request, value, index });
    if (r.status !== 'ok') throw new Error(`CH340 control 0x${request.toString(16)}: ${r.status}`);
  }

  async ctrlIn(request, value, index, length) {
    const r = await this.device.controlTransferIn({ requestType: 'vendor', recipient: 'device', request, value, index }, length);
    if (r.status !== 'ok') throw new Error(`CH340 control in 0x${request.toString(16)}: ${r.status}`);
    return r.data;
  }

  async setBaud(baud) {
    // divisor / prescaler as usb-serial-for-android computes them
    let factor = Math.floor(1532620800 / baud);
    let divisor = 3;
    while (factor > 0xfff0 && divisor > 0) {
      factor >>= 3;
      divisor--;
    }
    if (factor > 0xfff0) throw new Error('unsupported baud rate ' + baud);
    factor = 0x10000 - factor;
    divisor |= 0x80; // send at once instead of waiting for a full buffer
    await this.ctrlOut(REQ_WRITE_REG, 0x1312, (factor & 0xff00) | divisor);
    await this.ctrlOut(REQ_WRITE_REG, 0x0f2c, factor & 0xff);
  }

  async writeModem() {
    const bits = (this.dtr ? BIT_DTR : 0) | (this.rts ? BIT_RTS : 0);
    await this.ctrlOut(REQ_MODEM_CTRL, ~bits & 0xffff, 0); // active low
    this.log(`  [usb] DTR=${this.dtr ? 1 : 0} RTS=${this.rts ? 1 : 0}`);
  }

  async open({ baudRate = 115200 } = {}) {
    const d = this.device;
    if (!d.opened) await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    const iface = d.configuration.interfaces[0];
    this.ifaceNumber = iface.interfaceNumber;
    if (!iface.claimed) await d.claimInterface(this.ifaceNumber);
    const eps = iface.alternate.endpoints.filter((e) => e.type === 'bulk');
    this.epIn = eps.find((e) => e.direction === 'in').endpointNumber;
    this.epOut = eps.find((e) => e.direction === 'out').endpointNumber;
    this.packetIn = eps.find((e) => e.direction === 'in').packetSize || 32;

    const ver = await this.ctrlIn(REQ_READ_VERSION, 0, 0, 8);
    this.log(`  [usb] CH34x version 0x${ver.getUint8(0).toString(16)}, endpoints in ${this.epIn} out ${this.epOut}, ${baudRate} baud`);
    await this.ctrlOut(REQ_SERIAL_INIT, 0, 0);
    await this.setBaud(baudRate);
    await this.ctrlOut(REQ_WRITE_REG, 0x2518, LCR_8N1);
    await this.writeModem();

    this.opened = true;
    const port = this;
    this.readable = new ReadableStream({
      async pull(controller) {
        while (port.opened) {
          let r;
          try {
            r = await d.transferIn(port.epIn, 4096);
          } catch (e) {
            if (!port.opened) break;
            controller.error(e);
            return;
          }
          if (r.data && r.data.byteLength) {
            port.rxBytes += r.data.byteLength;
            controller.enqueue(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
            return;
          }
        }
        try {
          controller.close();
        } catch (e) { /* cancelled */ }
      },
      cancel() {},
    });
    this.writable = new WritableStream({
      async write(chunk) {
        port.txBytes += chunk.byteLength;
        const r = await d.transferOut(port.epOut, chunk);
        if (r.status !== 'ok') throw new Error('USB write: ' + r.status);
      },
    });
  }

  async setSignals({ dataTerminalReady, requestToSend } = {}) {
    if (dataTerminalReady !== undefined) this.dtr = dataTerminalReady;
    if (requestToSend !== undefined) this.rts = requestToSend;
    await this.writeModem();
  }

  async close() {
    this.opened = false;
    try {
      if (this.readable && !this.readable.locked) await this.readable.cancel();
    } catch (e) { /* already closed */ }
    this.readable = null;
    this.writable = null;
    try {
      await this.device.releaseInterface(this.ifaceNumber);
    } catch (e) { /* not claimed */ }
    try {
      await this.device.close();
    } catch (e) { /* already closed */ }
  }
}
