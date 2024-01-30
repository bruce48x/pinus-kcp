const nodeKcp = require('node-kcp-x');
const { EventEmitter } = require('events');
const Protocol = require('pinus-protocol');
const Package = Protocol.Package;
const Message = Protocol.Message;
const protocol = Protocol.Protocol;
const { Protobuf } = require('pinus-protobuf');
const dgram = require('dgram');
const { commonHandler } = require('./commonHandler');
const path = require('path');
const { getLogger } = require('pinus-logger');
let logger = getLogger('pinus', path.basename(__filename));
// const { constants }  = require('../config/constants');
const constants = require('./constants');

const handshankeData = {
    sys: {
        type: 'client-simulator',
        version: '0.1.0',
        rsa: {},
    },
    user: {},
};

const gapThreshold = 100; // heartbeat gap threashold

function handlePackage(thiz, data) {
    if (!data) {
        return;
    }
    const pkg = Package.decode(data);
    if (Array.isArray(pkg)) {
        for (const p of pkg) {
            if (thiz._isHandshakeACKPackage(p.type)) {
                thiz.netState = constants.netState.ST_WORKING;
            }
            commonHandler(thiz, p);
        }
    } else {
        if (thiz._isHandshakeACKPackage(pkg.type)) {
            thiz.netState = constants.netState.ST_WORKING;
        }
        commonHandler(thiz, pkg);
    }
}

function output(data, size, thiz) {
    if (!thiz.socket) {
        return;
    }

    thiz.socket.send(data, 0, size, thiz.opts.port, thiz.opts.host, (err, bytes) => {
        if (err) {
            // logger.warn(err);
            logger.info('_output() 出错了', err);
            process.exit(0);
        }
    });
}

class PinusKcpClient extends EventEmitter {
    constructor(opts) {
        super();
        this._userId = opts.userId;
        this.callbacks = {};
        this.opts = opts;

        this.netState = constants.netState.ST_INITED;
        this.socket = null;
        this.kcpObj = undefined;

        this.heartbeatInterval = null;
        this.heartbeatTimeout = null;
        this.nextHeartbeatTimeout = null;
        this.heartbeatTimeoutId = null;
        this.heartbeatId = null;

        this.reqId = 0;

        this.dict = null;
        this.abbrs = null;
        this.protos = null;

        // kcp 初始化
        this.kcpObj = new nodeKcp.KCP(this.opts.conv, this);
        const nodelay = this.opts.nodelay || 0;
        const interval = this.interval || 100;
        const resend = this.opts.resend || 0;
        const nc = this.opts.nc || 0;
        this.kcpObj.nodelay(nodelay, interval, resend, nc);

        const sndwnd = this.opts.sndwnd || 32;
        const rcvwnd = this.opts.rcvwnd || sndwnd;
        this.kcpObj.wndsize(sndwnd, rcvwnd);

        const mtu = this.opts.mtu || 1400;
        this.kcpObj.setmtu(mtu);
        this.kcpObj.output(output);
        if (opts.stream) {
            this.kcpObj.stream(1);
            this.nextMsgLength = 0;
            this.tmpBuffer = undefined;
        }
    }

    destroy() {
        this.disconnect();
        this.removeAllListeners('handshake');
        this.removeAllListeners('heartbeat');
        this.removeAllListeners('message');
    }

    async connect() {
        this.socket = dgram.createSocket('udp4');
        this.socket.on('close', (had_error) => {
            logger.info('socket on close, had error = ', had_error);
            // process.exit(0);
        });
        this.socket.on('error', (err) => {
            logger.info('socket on error', err);
            // process.exit(0);
        });
        this.socket.on('listening', () => {
            // logger.info('kcp socket on listening');
        });
        this.socket.on('message', (msg) => {
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
                            const piece = data.slice(readOffset, readOffset + this.nextMsgLength - this.tmpBuffer.byteLength);
                            readOffset += this.nextMsgLength - this.tmpBuffer.byteLength;
                            this.nextMsgLength = 0;
                            const buffer = Buffer.concat([this.tmpBuffer, piece]);
                            this.tmpBuffer = undefined;
                            handlePackage(this, buffer);
                        } else {
                            // 不完整的包
                            this.tmpBuffer = Buffer.concat([this.tmpBuffer, data.slice(readOffset)]);
                            readOffset = totalLen;
                        }
                    } else {
                        if (data.slice(readOffset).byteLength >= this.nextMsgLength) {
                            // 有完整的包
                            const piece = data.slice(readOffset, readOffset + this.nextMsgLength);
                            readOffset += this.nextMsgLength;
                            this.nextMsgLength = 0;
                            handlePackage(this, piece);
                        } else {
                            // 不完整的包
                            this.tmpBuffer = data.slice(readOffset);
                            readOffset = totalLen;
                        }
                    }
                }
            } else {
                // 消息模式
                handlePackage(this, data);
            }
        });

        this.on('heartbeat', this._handleHeartbeat);
        this.on('message', (pkg, peer) => {
            // console.log('收到 pinus pkg', pkg);
            const msg = Message.decode(pkg.body);
            if (msg.compressRoute && this.abbrs && this.abbrs[msg.route]) {
                msg.route = this.abbrs[msg.route];
            }
            msg.body = this._decode(msg.route, msg.body);
            if (msg.type === Message.TYPE_PUSH && !msg.id) {
                logger.trace('kcp 响应', msg.route, msg.body);
                this.emit(msg.route, msg.body);
            } else if (msg.type == Message.TYPE_RESPONSE) {
                const { id, body } = msg;
                const cb = this.callbacks[id];
                logger.trace('kcp 响应', msg.route, body);
                if (cb) {
                    cb(body);
                    delete this.callbacks[id];
                }
            }
        });


        this.check();

        // 握手
        const handshakeBuff = Package.encode(
            Package.TYPE_HANDSHAKE,
            protocol.strencode(JSON.stringify(handshankeData)),
        );
        this.send(handshakeBuff);
        await this._connComplete();
    }

    disconnect() {
        logger.info('disconnect()');
        this.netState = constants.netState.ST_CLOSED;
        if (this.socket) {
            this.kcpObj = null;
            this.socket.close();
            this.socket = null;
        }
    }

    _connComplete() {
        return new Promise((resolve, reject) => {
            this.on('handshake', (data) => {
                if (data.code === constants.responseState.RES_OLD_CLIENT) {
                    throw new Error('client version not fullfill');
                }

                if (data.code !== constants.responseState.RES_OK) {
                    throw new Error('handshake fail');
                }

                this._handshakeInit(data);
                this.netState = constants.netState.ST_WORKING;

                const obj = Package.encode(Package.TYPE_HANDSHAKE_ACK);
                this.send(obj);
                process.nextTick(() => {
                    resolve();
                });
            });
        });
    }

    // ============================================== kcp ==============================================

    // _output(data, size, thiz) {
    //     if (thiz.fecEncoder) {
    //         thiz.fecEncoder.encode(data, (err, result) => {
    //             if (err) {
    //                 logger.error(err);
    //                 return;
    //             }
    //             const { data, parity } = result;
    //             const dataArr: Buffer[] = [];
    //             if (data?.length) {
    //                 dataArr.push(...data);
    //             }
    //             if (parity?.length) {
    //                 dataArr.push(...parity);
    //             }
    //             for (const buff of dataArr) {
    //                 thiz.socket.send(buff, 0, buff.byteLength, thiz.port, thiz.host);
    //             }
    //         });
    //     } else {
    //         thiz.socket.send(data, 0, size, thiz.port, thiz.host);
    //     }
    //     if (!!thiz.socket) {
    //         thiz.socket.send(data, 0, size, thiz.opts.port, thiz.opts.host, (err, bytes) => {
    //             if (err) {
    //                 // logger.warn(err);
    //                 logger.info('_output() 出错了', err);
    //                 process.exit(0);
    //             }
    //         });
    //     }
    // }

    send(buff) {
        if (this.opts.stream) {
            this.kcpObj.send(this.encodeStreamLength(buff));
        } else {
            this.kcpObj.send(buff);
        }
        this.kcpObj.flush();
    }

    check() {
        if (this.kcpObj) {
            const now = Date.now();
            this.kcpObj.update(now);
            setTimeout(() => {
                this.check();
            }, this.kcpObj.check(now));
        }
    }

    encodeStreamLength(buffer) {
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

    decodeStreamLength(buff) {
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

    // ============================================== socket 数据处理 ==============================================

    _isHandshakeACKPackage(type) {
        return type === Package.TYPE_HANDSHAKE_ACK;
    }

    // ============================================== 握手 ==============================================

    _initData(data) {
        if (!data || !data.sys) {
            return;
        }
        this.dict = data.sys.dict;
        this.protos = data.sys.protos;

        //todo 暂时不支持 路由压缩
        //Init compress dict
        if (this.dict) {
            // dict = dict;
            this.abbrs = {};

            for (const route in this.dict) {
                this.abbrs[this.dict[route]] = route;
            }
        }

        //Init protobuf protos
        if (this.protos) {
            const protoVersion = this.protos.version || 0;
            const serverProtos = this.protos.server || {};
            const clientProtos = this.protos.client || {};

            //Save protobuf protos to localStorage
            // window.localStorage.setItem('protos', JSON.stringify(protos));
            // this.protos = JSON.stringify(protos);

            if (!!this.protobuf) {
                this.protobuf = new Protobuf({ encoderProtos: this.protos.client, decoderProtos: this.protos.server });
            }
            // if (!!decodeIO_protobuf) {
            //     decodeIO_encoder = decodeIO_protobuf.loadJson(clientProtos);
            //     decodeIO_decoder = decodeIO_protobuf.loadJson(serverProtos);
            // }
        }
    }

    _handshakeInit(data) {
        if (data.sys && data.sys.heartbeat) {
            this.heartbeatInterval = data.sys.heartbeat * 1000; // heartbeat interval
            this.heartbeatTimeout = this.heartbeatInterval * 2; // max heartbeat timeout
        } else {
            this.heartbeatInterval = 0;
            this.heartbeatTimeout = 0;
        }

        this._initData(data);

        // if (typeof handshakeCallback === 'function') {
        //     handshakeCallback(data.user);
        // }
    }

    // ============================================== 心跳 ==============================================

    _heartbeatTimeoutCb() {
        logger.info(`kcp heartbeat timeout`);
        const gap = this.nextHeartbeatTimeout - Date.now();
        if (gap > gapThreshold) {
            this.heartbeatTimeoutId = setTimeout(this._heartbeatTimeoutCb.bind(this), gap);
        } else {
            // throw new Error('server heartbeat timeout');
            this.emit('heartbeatTimeout');
        }
    }

    _handleHeartbeat() {
        if (!this.heartbeatInterval) {
            return;
        }

        const obj = Package.encode(Package.TYPE_HEARTBEAT);
        if (this.heartbeatTimeoutId) {
            clearTimeout(this.heartbeatTimeoutId);
            this.heartbeatTimeoutId = null;
        }

        if (this.heartbeatId) {
            // already in a heartbeat interval
            return;
        }
        this.heartbeatId = setTimeout(() => {
            this.heartbeatId = null;
            this.send(obj);

            this.nextHeartbeatTimeout = Date.now() + this.heartbeatTimeout;
            this.heartbeatTimeoutId = setTimeout(this._heartbeatTimeoutCb.bind(this), this.heartbeatTimeout);
        }, this.heartbeatInterval);
    }

    // ============================================== 对外 API ==============================================

    _encode(route, msg) {
        if (this.protos && this.protos.client[route]) {
            // logger.info('protobuf 编码');
            msg = this.protobuf.encode(route, msg);
        } else {
            msg = protocol.strencode(JSON.stringify(msg));
        }
        return msg;
    }

    _decode(route, body) {
        if (this.protos && this.protos.server[route]) {
            // logger.info('protobuf 解析');
            body = this.protobuf.decode(route, body);
        } else {
            body = JSON.parse(protocol.strdecode(body));
        }
        return body;
    }

    _routeCompress(route) {
        if (this.dict && this.dict[route]) {
            return { route: this.dict[route], compressRoute: 1 };
        }
        return { route: route, compressRoute: 0 };
    }

    async request(route, msg) {
        if (!route) {
            throw new Error('route cannot be null or undefined');
        }
        if (!msg) {
            msg = {};
        }
        logger.trace(`发起 ${route} = `, msg);
        const reqId = ++this.reqId;
        msg = this._encode(route, msg);
        const res = this._routeCompress(route);
        const compressRoute = res.compressRoute;
        route = res.route;
        const encodedMsg = Message.encode(reqId, Message.TYPE_REQUEST, !!compressRoute, route, msg);
        const buff = Package.encode(Package.TYPE_DATA, encodedMsg);
        this.send(buff);
        return new Promise((resolve, reject) => {
            const cb = (res) => {
                if (res && res.code == 0) {
                    resolve(res);
                } else {
                    reject(res);
                }
            };
            this.callbacks[reqId] = cb;
        });
    }

    notify(route, msg) {
        // logger.info(`notify ${route} = `, msg);
        msg = this._encode(route, msg);
        const res = this._routeCompress(route);
        const compressRoute = res.compressRoute;
        route = res.route;
        const encodedMsg = Message.encode(0, Message.TYPE_NOTIFY, !!compressRoute, route, msg);
        const buff = Package.encode(Package.TYPE_DATA, encodedMsg);
        this.send(buff);
    }
}

module.exports = {
    PinusKcpClient
};