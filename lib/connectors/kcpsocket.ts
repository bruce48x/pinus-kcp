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

import { EventEmitter } from 'events';
import kcp from 'node-kcp-x';
import pomelocoder from './pomelocoder';
import * as protocol from 'pinus-protocol';
const Package = protocol.Package;
import dgram from 'dgram';
import { ISocket } from '../interfaces/ISocket';

const ST_INITED = 0;
const ST_WAIT_ACK = 1;
const ST_WORKING = 2;
const ST_CLOSED = 3;

enum State {
    INITED = 0,
    WAIT_ACK = 1,
    WORKING = 2,
    CLOSED = 3,
};

var output = function (data: any, size: number, thiz: any) {
    if (thiz.opts && thiz.opts.useUDP) {
        thiz.socket.send(data, 0, size, thiz.port, thiz.host);
    } else {
        thiz.socket.write(data);
    }
};

export default class KcpSocket extends EventEmitter implements ISocket {
    id: number;
    socket: dgram.Socket;
    host: string;
    port: number;
    remoteAddress: any;
    opts: any;
    kcpobj: kcp.KCP | null;
    state: number;
    _initTimer: NodeJS.Timer | null;

    constructor(id: number, socket: dgram.Socket, address: string, port: number, opts: any) {
        super();
        var self = this;
        this.id = id;
        this.socket = socket;
        this.host = address;
        this.port = port;
        this.remoteAddress = {
            ip: this.host,
            port: this.port
        };
        this.opts = opts;
        var conv = opts.conv || 123;
        this.kcpobj = new kcp.KCP(conv, self);
        if (!!opts) {
            var nodelay = opts.nodelay || 0;
            var interval = opts.interval || 100;
            var resend = opts.resend || 0;
            var nc = opts.nc || 0;
            this.kcpobj.nodelay(nodelay, interval, resend, nc);

            var sndwnd = opts.sndwnd || 32;
            var rcvwnd = opts.rcvwnd || sndwnd;
            this.kcpobj.wndsize(sndwnd, rcvwnd);

            var mtu = opts.mtu || 1400;
            this.kcpobj.setmtu(mtu);
        }
        this.kcpobj.output(output);
        this.on('input', (msg) => {
            if (!this.kcpobj) {
                return;
            }
            this.kcpobj.input(msg);
            var data = this.kcpobj.recv();
            if (!!data) {
                if (self.opts && self.opts.usePomeloPackage) {
                    pomelocoder.handlePackage(self, data);
                } else {
                    self.emit('message', data);
                }
            }
        });

        this.check();
        if (!!opts && opts.usePomeloPackage) {
            this.state = ST_INITED;
        } else {
            this.state = ST_WORKING;
        }

        // 超时还未握手就绪，就删除此 socket
        this._initTimer = setTimeout(() => {
            if (this.state === ST_INITED
                || this.state !== ST_WORKING) {
                this.disconnect();
            }
            this._initTimer = null;
        }, 5000);
    };

    check() {
        if (!this.kcpobj) {
            return;
        }
        const now = Date.now();
        this.kcpobj.update(now);
        setTimeout(() => {
            this.check();
        }, this.kcpobj.check(now));
    };

    send(msg: any) {
        if (this.state != ST_WORKING) {
            return;
        }
        if (typeof msg === 'string') {
            msg = Buffer.from(msg);
        } else if (!(msg instanceof Buffer)) {
            msg = Buffer.from(JSON.stringify(msg));
        }
        this.sendRaw(this.opts.usePomeloPackage ? Package.encode(Package.TYPE_DATA, msg) : msg);
    };

    sendRaw(msg: Buffer) {
        if (!this.kcpobj) {
            return;
        }
        this.kcpobj.send(msg);
        this.kcpobj.flush();
    };

    sendForce(msg: Buffer) {
        if (this.state == ST_CLOSED) {
            return;
        }
        this.sendRaw(msg);
    };

    sendBatch(msgs: Buffer[]) {
        if (this.state != ST_WORKING) {
            return;
        }
        var rs = [];
        for (var i = 0; i < msgs.length; i++) {
            rs.push(this.opts.usePomeloPackage ? Package.encode(Package.TYPE_DATA, msgs[i]) : msgs[i]);
        }
        this.sendRaw(Buffer.concat(rs));
    };

    handshakeResponse(resp: Buffer) {
        if (this.state !== ST_INITED) {
            return;
        }
        this.sendRaw(resp);
        this.state = ST_WAIT_ACK;
    };

    disconnect() {
        if (this.state == ST_CLOSED) {
            return;
        }
        this.state = ST_CLOSED;
        this.emit('disconnect', 'kcp connection disconnected');
        if (this.kcpobj) {
            this.kcpobj.release();
            this.kcpobj = null;
        }
    };
}