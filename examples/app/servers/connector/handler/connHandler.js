const path = require('path');
const { getLogger } = require('pinus-logger');
let logger = getLogger('pinus', path.basename(__filename));

class ConnHandler {
    constructor(app) {
        this.app = app;
    }

    async echo(msg, session) {
        logger.info('recv msg', msg);
        return { code: 0, msg };
    }
}

exports.default = function (app) {
    return new ConnHandler(app);
}
