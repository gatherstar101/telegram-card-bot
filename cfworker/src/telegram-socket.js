import { connect } from 'cloudflare:sockets';

function closedError() {
  const error = new Error('Telegram TCP socket closed');
  error.name = 'NetSocketClosedError';
  return error;
}

// Teleproto's socket interface over Workers' native TCP streams. The socket
// belongs to a single request; only StringSession is retained between calls.
export class TelegramSocket {
  constructor(proxy) {
    if (proxy) throw new Error('Proxies are not supported by this transport');
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    this.pendingWrite = Promise.resolve();
  }
  async connect(port,hostname) {
    this.socket = connect({hostname,port}, {secureTransport:'off',allowHalfOpen:false});
    // Observe closure rejection even when connecting fails before readers exist.
    this.socket.closed.catch(() => {});
    let timer;
    try {
      await Promise.race([this.socket.opened,new Promise((_,reject) => {
        timer = setTimeout(() => reject(new Error('Telegram TCP connection timed out')),15000);
      })]);
      this.reader = this.socket.readable.getReader();
      this.writer = this.socket.writable.getWriter();
      this.closed = false;
    } catch (error) { await this.close(); throw error; }
    finally { clearTimeout(timer); }
  }
  async read(n) {
    if (this.closed) throw closedError();
    while (!this.buffer.length) {
      const {done,value} = await this.reader.read();
      if (done || this.closed) { this.closed = true; throw closedError(); }
      this.buffer = Buffer.from(value);
    }
    const value = this.buffer.subarray(0,n);
    this.buffer = this.buffer.subarray(value.length);
    return value;
  }
  async readExactly(n) {
    const parts = [];
    let remaining = n;
    while (remaining > 0) {
      const part = await this.read(remaining);
      parts.push(part);
      remaining -= part.length;
    }
    return Buffer.concat(parts,n);
  }
  write(data) {
    if (this.closed) throw closedError();
    // Some Teleproto connection codecs do not await write(). Track failures so
    // read() wakes with a closed socket rather than producing a leaked rejection.
    const bytes = Uint8Array.from(data);
    this.pendingWrite = this.pendingWrite.then(() => this.writer.write(bytes));
    this.pendingWrite.catch(() => this.close());
    return this.pendingWrite;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([this.reader?.cancel(),this.socket?.close()]);
  }
  toString() { return 'WorkersTelegramSocket'; }
}
