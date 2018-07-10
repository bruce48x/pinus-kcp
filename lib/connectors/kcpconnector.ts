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

import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import KcpSocket from './kcpsocket';
import * as pinuscoder from './pinuscoder';

let curId = 1;

export class Connector extends EventEmitter {
    opts: any;
    host: string;
    port: number;
    useDict: boolean;
    useProtobuf: boolean;
    clientsForKcp: any;
    connector: any;
    dictionary: any;
    protobuf: any;
    decodeIO_protobuf: any;
    socket: dgram.Socket;

    constructor(port: number, host: string, opts: any) {
        super();
        this.opts = opts || {};
        this.host = host;
        this.port = port;
        this.useDict = opts.useDict;
        this.useProtobuf = opts.useProtobuf;
        this.clientsForKcp = new Map<number, any>();
        this.socket = dgram.createSocket('udp4');
    };

    start(cb: () => void) {
        var self = this;
        if (this.opts.usePomeloPackage) {
            var app = pinuscoder.getApp();
            this.connector = app.components.__connector__.connector;
            this.dictionary = app.components.__dictionary__;
            this.protobuf = app.components.__protobuf__;
            this.decodeIO_protobuf = app.components.__decodeIO__protobuf__;
        }
        this.socket.on('message', function (msg, peer) {
            self.bindSocket(self.socket, peer.address, peer.port, msg);
        });
        self.on('disconnect', function (kcpsocket) {
            const conv = kcpsocket.opts.conv;
            delete self.clientsForKcp[conv];
        });
        this.socket.on('error', function (error) {
            return;
        });

        this.socket.bind(this.port);
        process.nextTick(cb);
    };

    bindSocket(socket: dgram.Socket, address: string, port: number, msg?: any) {
        const self = this;
        let conv, kcpsocket: KcpSocket | undefined;
        if (msg) {
            var kcpHead = pinuscoder.kcpHeadDecode(msg);
            conv = kcpHead.conv;
            kcpsocket = self.clientsForKcp[conv];
        }
        if (!kcpsocket && conv) {
            kcpsocket = new KcpSocket(curId++, socket, address, port, Object.assign({ conv: conv }, self.opts));
            if (!!self.opts && self.opts.usePomeloPackage) {
                pinuscoder.setupHandler(self, kcpsocket, self.opts);
            }
            self.clientsForKcp[conv] = kcpsocket;
            self.emit('connection', kcpsocket);
        }
        if (!!msg && !!kcpsocket) {
            kcpsocket.emit('input', msg);
        }
    };
    // static decode = decode;
    decode(msg: Buffer | string) {
        if (this.opts && this.opts.usePomeloPackage) {
            return pinuscoder.decode.bind(this)(msg);
        } else {
            if (msg instanceof Buffer) {
                return JSON.parse(msg.toString());
            } else {
                return JSON.parse(msg);
            }
        }
    };

    // static encode 
    encode(reqid: number, route: string, msg: any) {
        if (this.opts && this.opts.usePomeloPackage) {
            return pinuscoder.encode.bind(this)(reqid, route, msg);
        } else {
            return JSON.stringify({
                id: reqid,
                route: route,
                body: msg
            });
        }
    };

    stop(force: any, cb: () => void) {
        if (this.socket) {
            this.socket.close();
        }
        process.nextTick(cb);
    };
}

