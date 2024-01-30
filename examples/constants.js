module.exports = {
    HEAD_SIZE: 4,
    readState: {
        ST_HEAD: 0,
        ST_BODY: 1,
        ST_CLOSED: 2,
    },
    netState: {
        ST_INITED: 0,
        ST_WAIT_ACK: 1,
        ST_WORKING: 2,
        ST_CLOSED: 3,
    },
    responseState: {
        RES_OK: 200,
        RES_FAIL: 500,
        RES_OLD_CLIENT: 501,
    },
    side: {
        SIDE_RED: 1,
        SIDE_BLUE: 2,
    },
};


