/**
 * Copyright 2016 leenjewel
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as path from 'path';
import { getLogger } from 'pinus-logger';
let logger = getLogger('pinus', path.basename(__filename));
import { EventEmitter } from 'events';
import * as kcp from 'node-kcp-x';
import * as pinuscoder from './pinuscoder';
import * as protocol from 'pinus-protocol';
const Package = protocol.Package;
import * as dgram from 'dgram';
import { ISocket } from '../interfaces/ISocket';
import { NetState } from '../const/const';

function output(data: any, size: number, thiz: KcpSocket) {
    thiz.socket.send(data, 0, size, thiz.port, thiz.host);
};

export class KcpSocket extends EventEmitter implements ISocket {
    id: number;
    socket: dgram.Socket;
    host: string;
    port: number;
    remoteAddress: any;
    opts: any;
    kcpObj: kcp.KCP | null;
    state: number;
    _initTimer: NodeJS.Timer | null;
    heartbeatOnData: boolean;

    // stream
    nextMsgLength: number;
    tmpBuffer: Buffer;

    constructor(id: number, socket: dgram.Socket, address: string, port: number, opts: any) {
        super();
        this.id = id;
        this.socket = socket;
        this.host = address;
        this.port = port;
        this.remoteAddress = {
            ip: this.host,
            port: this.port
        };
        this.opts = opts;
        const conv = opts.conv || 123;
        this.kcpObj = new kcp.KCP(conv, this);
        if (!!opts) {
            this.heartbeatOnData = !!opts.heartbeatOnData;
            const nodelay = opts.nodelay || 0;
            const interval = opts.interval || 100;
            const resend = opts.resend || 0;
            const nc = opts.nc || 0;
            this.kcpObj.nodelay(nodelay, interval, resend, nc);

            const sndwnd = opts.sndwnd || 32;
            const rcvwnd = opts.rcvwnd || sndwnd;
            this.kcpObj.wndsize(sndwnd, rcvwnd);

            const mtu = opts.mtu || 1400;
            this.kcpObj.setmtu(mtu);
            if (opts.stream) {
                this.kcpObj.stream(1);
                this.nextMsgLength = 0;
                this.tmpBuffer = undefined;
            }
        }
        this.kcpObj.output(output);
        this.on('input', (msg) => {
            if (!this.kcpObj) {
                return;
            }
            this.kcpObj.input(msg);
            let data = this.kcpObj.recv();
            if (!data) {
                return;
            }
            if (this.opts.stream) {
                // stream 模式
                const totalLen = data.byteLength;
                let readOffset = 0;
                while (readOffset < totalLen) {
                    if (!this.nextMsgLength) {
                        if (this.tmpBuffer) {
                            const concatedBuff = Buffer.concat([this.tmpBuffer, data.slice(readOffset)]);
                            const { len, offset } = this.decodeStreamLength(concatedBuff);
                            if (!len) {
                                // 数据不完整
                                this.tmpBuffer = concatedBuff;
                            } else {
                                this.nextMsgLength = len;
                                readOffset += offset;
                            }
                        } else {
                            const { len, offset } = this.decodeStreamLength(data.slice(readOffset));
                            if (!len) {
                                // 数据不完整
                                this.tmpBuffer = data;
                            } else {
                                this.nextMsgLength = len;
                                readOffset += offset;
                            }
                        }
                    }
                    if (this.tmpBuffer) {
                        if (this.tmpBuffer.byteLength + data.slice(readOffset).byteLength >= this.nextMsgLength) {
                            // 有完整的包
                            const piece = data.slice(readOffset, readOffset+this.nextMsgLength - this.tmpBuffer.byteLength);
                            readOffset += this.nextMsgLength - this.tmpBuffer.byteLength;
                            this.nextMsgLength = 0;
                            const buffer = Buffer.concat([this.tmpBuffer,piece]);
                            this.tmpBuffer = undefined;
                            if (0 !== pinuscoder.handlePackage(this, buffer)) {
                                break;
                            }
                        } else {
                            // 不完整的包
                            this.tmpBuffer = Buffer.concat([this.tmpBuffer, data.slice(readOffset)]);
                            readOffset = totalLen;
                        }
                    } else {
                        if (data.slice(readOffset).byteLength >= this.nextMsgLength) {
                            // 有完整的包
                            const piece = data.slice(readOffset, readOffset+this.nextMsgLength);
                            readOffset += this.nextMsgLength;
                            this.nextMsgLength = 0;
                            if (0 !== pinuscoder.handlePackage(this, piece)) {
                                break;
                            }
                        } else {
                            // 不完整的包
                            this.tmpBuffer = data.slice(readOffset);
                            readOffset = totalLen;
                        }
                    }
                }
            } else {
                // 消息模式
                pinuscoder.handlePackage(this, data);
            }
        });

        this.check();
        this.state = NetState.INITED;

        // 超时还未握手就绪，就删除此 socket
        this._initTimer = setTimeout(() => {
            if (this.state !== NetState.WORKING) {
                this.disconnect();
            }
            this._initTimer = null;
        }, 5000);
    }

    check() {
        if (!this.kcpObj) {
            return;
        }
        const now = Date.now();
        this.kcpObj.update(now);
        setTimeout(() => {
            this.check();
        }, this.kcpObj.check(now));
    }

    send(msg: any) {
        if (this.state != NetState.WORKING) {
            return;
        }
        if (typeof msg === 'string') {
            msg = Buffer.from(msg);
        } else if (!(msg instanceof Buffer)) {
            msg = Buffer.from(JSON.stringify(msg));
        }
        this.sendRaw(Package.encode(Package.TYPE_DATA, msg));
    }

    sendRaw(msg: Buffer) {
        if (!this.kcpObj) {
            return;
        }
        if (this.opts.stream) {
            this.kcpObj.send(this.encodeStreamLength(msg));
        } else {
            this.kcpObj.send(msg);
        }
    }

    sendForce(msg: Buffer) {
        if (this.state == NetState.CLOSED) {
            return;
        }
        this.sendRaw(msg);
    }

    sendBatch(msgs: Buffer[]) {
        if (this.state != NetState.WORKING) {
            return;
        }
        const rs = [];
        for (let i = 0; i < msgs.length; i++) {
            rs.push(Package.encode(Package.TYPE_DATA, msgs[i]));
        }
        this.sendRaw(Buffer.concat(rs));
    }

    handshakeResponse(resp: Buffer) {
        if (this.state !== NetState.INITED) {
            return;
        }
        this.sendRaw(resp);
        this.state = NetState.WAIT_ACK;
    }

    disconnect() {
        if (this.state == NetState.CLOSED) {
            return;
        }
        this.state = NetState.CLOSED;
        this.emit('disconnect', 'kcp connection disconnected');
        if (this.kcpObj) {
            this.kcpObj.release();
            this.kcpObj = null;
        }
    }

    encodeStreamLength(buffer: Buffer) {
        let len = buffer.byteLength;
        const lenBuff = Buffer.allocUnsafe(8).fill(0);
        let offset = 0;
        do {
            let tmp = len % 128;
            let next = Math.floor(len / 128);

            if (next !== 0) {
                tmp = tmp + 128;
            }
            lenBuff[offset++] = tmp;

            len = next;
        } while (len !== 0);
        return Buffer.concat([lenBuff.slice(0, offset), buffer]);
    }

    decodeStreamLength(buff: Buffer): { len: number; offset: number; } {
        let m = 0;
        let offset = 0;
        let len = 0;
        do {
            m = buff[offset];
            len = len | ((m & 0x7f) << (7 * offset));
            offset++;
            if (offset >= buff.byteLength && m >= 128) {
                // 数据不完整
                return { len: 0, offset: 0 };
            }
        } while (m >= 128);
        return { len, offset };
    }
}