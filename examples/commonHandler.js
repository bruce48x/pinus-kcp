const Protocol = require('pinus-protocol');
const protocol = Protocol.Protocol;
const Package = Protocol.Package;
const { getLogger } = require('pinus-logger');
const path = require('path');
let logger = getLogger('pinus', path.basename(__filename));
const constants = require('./constants');

const handlers = {};

const handleHandshake = function (client, pkg) {
    if (client.netState !== constants.netState.ST_INITED) {
        return;
    }
    try {
        client.emit('handshake', JSON.parse(protocol.strdecode(pkg.body)));
    } catch (ex) {
        logger.info(ex);
        client.emit('handshake', {});
    }
};

const handleHandshakeAck = function (client, pkg) {
    if (client.netState !== constants.netState.ST_WAIT_ACK) {
        return;
    }
    client.netState = constants.netState.ST_WORKING;
    client.emit('heartbeat');
};

const handleHeartbeat = function (client, pkg) {
    if (client.netState !== constants.netState.ST_WORKING) {
        return;
    }
    client.emit('heartbeat');
};

const handleData = function (client, pkg) {
    if (client.netState !== constants.netState.ST_WORKING) {
        return;
    }
    client.emit('message', pkg);
};

const handleKick = function (client, pkg) {
    if (client.netState !== constants.netState.ST_WORKING) {
        return;
    }
    const msg = JSON.parse(protocol.strdecode(pkg.body));
    logger.info('被踢', msg);
    client.emit('kick', msg);
};

handlers[Package.TYPE_HANDSHAKE] = handleHandshake;
handlers[Package.TYPE_HANDSHAKE_ACK] = handleHandshakeAck;
handlers[Package.TYPE_HEARTBEAT] = handleHeartbeat;
handlers[Package.TYPE_DATA] = handleData;
handlers[Package.TYPE_KICK] = handleKick;

function commonHandler(client, pkg) {
    const handler = handlers[pkg.type];
    if (!!handler) {
        handler(client, pkg);
    } else {
        logger.error('could not find handle invalid data package.', pkg, new Error().stack);
        client.disconnect();
    }
};

module.exports = {
    commonHandler,
}
