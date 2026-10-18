// Minimal RFC 6455 WebSocket server, zero dependencies.
// Same transport as mini_atys/server/net/websocket.js, as an ES module.

import crypto from 'crypto';
import { EventEmitter } from 'events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024;

export class WebSocketConnection extends EventEmitter {
	constructor(socket, remoteAddress) {
		super();
		this.socket = socket;
		this.remoteAddress = remoteAddress;
		this.open = true;
		this._buf = Buffer.alloc(0);
		this._fragments = [];
		this._fragOpcode = 0;

		socket.setNoDelay(true);
		socket.on('data', (chunk) => this._onData(chunk));
		socket.on('close', () => this._onClose());
		socket.on('error', () => this._onClose());
	}

	_onData(chunk) {
		this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
		if (this._buf.length > MAX_PAYLOAD * 2) return this.close(1009, 'too big');
		while (this.open) {
			const frame = this._parseFrame();
			if (!frame) break;
			this._handleFrame(frame);
		}
	}

	_parseFrame() {
		const b = this._buf;
		if (b.length < 2) return null;
		const fin = (b[0] & 0x80) !== 0;
		const opcode = b[0] & 0x0f;
		const masked = (b[1] & 0x80) !== 0;
		let len = b[1] & 0x7f;
		let off = 2;
		if (len === 126) {
			if (b.length < 4) return null;
			len = b.readUInt16BE(2);
			off = 4;
		} else if (len === 127) {
			if (b.length < 10) return null;
			const hi = b.readUInt32BE(2);
			if (hi !== 0) { this.close(1009, 'too big'); return null; }
			len = b.readUInt32BE(6);
			off = 10;
		}
		if (len > MAX_PAYLOAD) { this.close(1009, 'too big'); return null; }
		// Client-to-server frames must be masked (RFC 6455 5.1)
		if (!masked) { this.close(1002, 'unmasked'); return null; }
		if (b.length < off + 4 + len) return null;
		const mask = b.subarray(off, off + 4);
		off += 4;
		const payload = Buffer.allocUnsafe(len);
		for (let i = 0; i < len; i++) payload[i] = b[off + i] ^ mask[i & 3];
		this._buf = b.subarray(off + len);
		return { fin, opcode, payload };
	}

	_handleFrame({ fin, opcode, payload }) {
		switch (opcode) {
		case 0x0: // continuation
			if (!this._fragOpcode) return this.close(1002, 'bad continuation');
			this._fragments.push(payload);
			if (fin) {
				const data = Buffer.concat(this._fragments);
				const op = this._fragOpcode;
				this._fragments = [];
				this._fragOpcode = 0;
				if (data.length > MAX_PAYLOAD) return this.close(1009, 'too big');
				this._emitMessage(op, data);
			}
			break;
		case 0x1: // text
		case 0x2: // binary
			if (fin) this._emitMessage(opcode, payload);
			else { this._fragOpcode = opcode; this._fragments = [payload]; }
			break;
		case 0x8: // close
			this.close(1000);
			break;
		case 0x9: // ping
			this._sendFrame(0xA, payload);
			break;
		case 0xA: // pong
			break;
		default:
			this.close(1002, 'bad opcode');
		}
	}

	_emitMessage(opcode, data) {
		this.emit('message', opcode === 0x1 ? data.toString('utf8') : data);
	}

	_sendFrame(opcode, payload) {
		if (!this.open) return;
		const len = payload.length;
		let header;
		if (len < 126) {
			header = Buffer.from([0x80 | opcode, len]);
		} else if (len < 65536) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 126;
			header.writeUInt16BE(len, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 127;
			header.writeUInt32BE(0, 2);
			header.writeUInt32BE(len, 6);
		}
		this.socket.write(Buffer.concat([header, payload]));
	}

	send(text) {
		this._sendFrame(0x1, Buffer.from(text, 'utf8'));
	}

	get bufferedAmount() {
		return this.socket.writableLength;
	}

	close(code = 1000, reason = '') {
		if (!this.open) return;
		const r = Buffer.from(reason, 'utf8');
		const p = Buffer.alloc(2 + r.length);
		p.writeUInt16BE(code, 0);
		r.copy(p, 2);
		this._sendFrame(0x8, p);
		this.open = false;
		this.socket.end();
		this.emit('close', code);
	}

	_onClose() {
		if (this.open) {
			this.open = false;
			this.socket.destroy();
			this.emit('close', 1006);
		}
	}
}

// Attach to an http.Server; calls onConnection(ws, req) for each upgrade on `path`.
export function attachWebSocketServer(httpServer, path, onConnection) {
	httpServer.on('upgrade', (req, socket) => {
		const url = (req.url || '').split('?')[0];
		const key = req.headers['sec-websocket-key'];
		if (url !== path || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
			socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
			return;
		}
		const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\n' +
			'Upgrade: websocket\r\n' +
			'Connection: Upgrade\r\n' +
			'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
		onConnection(new WebSocketConnection(socket, req.socket.remoteAddress), req);
	});
}

