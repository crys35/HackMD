//realtime
//external modules
var cookie = require('cookie');
var cookieParser = require('cookie-parser');
var url = require('url');
var async = require('async');
var LZString = require('lz-string');
var shortId = require('shortid');
var randomcolor = require("randomcolor");
var Chance = require('chance'),
    chance = new Chance();
var md5 = require("blueimp-md5").md5;
var moment = require('moment');

//core
var config = require("../config.js");
var logger = require("./logger.js");

//others
var db = require("./db.js");
var Note = require("./note.js");
var User = require("./user.js");

//public
var realtime = {
    onAuthorizeSuccess: onAuthorizeSuccess,
    onAuthorizeFail: onAuthorizeFail,
    secure: secure,
    connection: connection,
    getStatus: getStatus
};

function onAuthorizeSuccess(data, accept) {
    accept(null, true);
}

function onAuthorizeFail(data, message, error, accept) {
    if (error) throw new Error(message);
    accept(null, true);
}

function secure(socket, next) {
    try {
        var handshakeData = socket.request;
        if (handshakeData.headers.cookie) {
            handshakeData.cookie = cookie.parse(handshakeData.headers.cookie);
            handshakeData.sessionID = cookieParser.signedCookie(handshakeData.cookie[config.sessionname], config.sessionsecret);
            if (handshakeData.cookie[config.sessionname] == handshakeData.sessionID) {
                next(new Error('AUTH failed: Cookie is invalid.'));
            }
        } else {
            next(new Error('AUTH failed: No cookie transmitted.'));
        }
        if (config.debug)
            logger.info("AUTH success cookie: " + handshakeData.sessionID);

        next();
    } catch (ex) {
        next(new Error("AUTH failed:" + JSON.stringify(ex)));
    }
}

//actions
var users = {};
var notes = {};
var updater = setInterval(function () {
    async.each(Object.keys(notes), function (key, callback) {
        var note = notes[key];
        if (note.isDirty) {
            if (config.debug)
                logger.info("updater found dirty note: " + key);
            var body = LZString.decompressFromUTF16(note.body);
            var title = Note.getNoteTitle(body);
            title = LZString.compressToBase64(title);
            body = LZString.compressToBase64(body);
            db.saveToDB(key, title, body,
                function (err, result) {});
            note.isDirty = false;
        }
        callback();
    }, function (err) {
        if (err) return logger.error('updater error', err);
    });
}, 5000);

function getStatus(callback) {
    db.countFromDB(function (err, data) {
        if (err) return logger.info(err);
        var distinctaddresses = [];
        var regaddresses = [];
        var distinctregaddresses = [];
        Object.keys(users).forEach(function (key) {
            var user = users[key];
            var found = false;
            for (var i = 0; i < distinctaddresses.length; i++) {
                if (user.address == distinctaddresses[i]) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                distinctaddresses.push(user.address);
            }
            if (user.login) {
                regaddresses.push(user.address);
                var found = false;
                for (var i = 0; i < distinctregaddresses.length; i++) {
                    if (user.address == distinctregaddresses[i]) {
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    distinctregaddresses.push(user.address);
                }
            }
        });
        User.getUserCount(function (err, regcount) {
            if (err) {
                logger.error('get status failed: ' + err);
                return;
            }
            if (callback)
                callback({
                    onlineNotes: Object.keys(notes).length,
                    onlineUsers: Object.keys(users).length,
                    distinctOnlineUsers: distinctaddresses.length,
                    notesCount: data.rows[0].count,
                    registeredUsers: regcount,
                    onlineRegisteredUsers: regaddresses.length,
                    distinctOnlineRegisteredUsers: distinctregaddresses.length
                });
        });
    });
}

function getNotenameFromSocket(socket) {
    var hostUrl = url.parse(socket.handshake.headers.referer);
    var notename = hostUrl.pathname.split('/')[1];
    if (notename == config.featuresnotename) {
        return notename;
    }
    if (!Note.checkNoteIdValid(notename)) {
        socket.emit('info', {
            code: 404
        });
        return socket.disconnect();
    }
    notename = LZString.decompressFromBase64(notename);
    return notename;
}

function emitOnlineUsers(socket) {
    var notename = getNotenameFromSocket(socket);
    if (!notename || !notes[notename]) return;
    var users = [];
    Object.keys(notes[notename].users).forEach(function (key) {
        var user = notes[notename].users[key];
        if (user)
            users.push(buildUserOutData(user));
    });
    var out = {
        users: users
    };
    out = LZString.compressToUTF16(JSON.stringify(out));
    for (var i = 0, l = notes[notename].socks.length; i < l; i++) {
        var sock = notes[notename].socks[i];
        if (sock && out)
            sock.emit('online users', out);
    };
}

function emitUserStatus(socket) {
    var notename = getNotenameFromSocket(socket);
    if (!notename || !notes[notename]) return;
    var out = buildUserOutData(users[socket.id]);
    for (var i = 0, l = notes[notename].socks.length; i < l; i++) {
        var sock = notes[notename].socks[i];
        if (sock != socket) {
            sock.emit('user status', out);
        }
    };
}

function emitRefresh(socket) {
    var notename = getNotenameFromSocket(socket);
    if (!notename || !notes[notename]) return;
    var note = notes[notename];
    socket.emit('refresh', {
        owner: note.owner,
        permission: note.permission,
        body: note.body,
        otk: note.otk,
        hash: note.hash,
        updatetime: note.updatetime
    });
}

var isConnectionBusy = false;
var connectionSocketQueue = [];
var isDisconnectBusy = false;
var disconnectSocketQueue = [];

function finishConnection(socket, notename) {
    notes[notename].users[socket.id] = users[socket.id];
    notes[notename].socks.push(socket);
    emitOnlineUsers(socket);
    emitRefresh(socket);

    //clear finished socket in queue
    for (var i = 0; i < connectionSocketQueue.length; i++) {
        if (connectionSocketQueue[i].id == socket.id)
            connectionSocketQueue.splice(i, 1);
    }
    //seek for next socket
    isConnectionBusy = false;
    if (connectionSocketQueue.length > 0)
        startConnection(connectionSocketQueue[0]);

    if (config.debug) {
        logger.info('SERVER connected a client to [' + notename + ']:');
        logger.info(JSON.stringify(users[socket.id]));
        //logger.info(notes);
        getStatus(function (data) {
            logger.info(JSON.stringify(data));
        });
    }
}

function startConnection(socket) {
    if (isConnectionBusy) return;
    isConnectionBusy = true;

    var notename = getNotenameFromSocket(socket);
    if (!notename) return;

    if (!notes[notename]) {
        db.readFromDB(notename, function (err, data) {
            if (err) {
                socket.emit('info', {
                    code: 404
                });
                socket.disconnect();
                //clear err socket in queue
                for (var i = 0; i < connectionSocketQueue.length; i++) {
                    if (connectionSocketQueue[i].id == socket.id)
                        connectionSocketQueue.splice(i, 1);
                }
                isConnectionBusy = false;
                return logger.error(err);
            }
            var owner = data.rows[0].owner;
            var permission = "freely";
            if (owner && owner != "null") {
                permission = "editable";
            }
            Note.findOrNewNote(notename, permission, function (err, note) {
                if (err) {
                    responseError(res, "404", "Not Found", "oops.");
                    return;
                }
                var body = LZString.decompressFromBase64(data.rows[0].content);
                body = LZString.compressToUTF16(body);
                var updatetime = data.rows[0].update_time;
                notes[notename] = {
                    owner: owner,
                    permission: note.permission,
                    socks: [],
                    body: body,
                    isDirty: false,
                    users: {},
                    otk: shortId.generate(),
                    hash: md5(body),
                    updatetime: moment(updatetime).valueOf()
                };
                finishConnection(socket, notename);
            });
        });
    } else {
        finishConnection(socket, notename);
    }
}

function disconnect(socket) {
    if (isDisconnectBusy) return;
    isDisconnectBusy = true;

    if (config.debug) {
        logger.info("SERVER disconnected a client");
        logger.info(JSON.stringify(users[socket.id]));
    }
    var notename = getNotenameFromSocket(socket);
    if (!notename) return;
    if (users[socket.id]) {
        delete users[socket.id];
    }
    if (notes[notename]) {
        delete notes[notename].users[socket.id];
        do {
            var index = notes[notename].socks.indexOf(socket);
            if (index != -1) {
                notes[notename].socks.splice(index, 1);
            }
        } while (index != -1);
        if (Object.keys(notes[notename].users).length <= 0) {
            if (notes[notename].isDirty) {
                var body = LZString.decompressFromUTF16(notes[notename].body);
                var title = Note.getNoteTitle(body);
                title = LZString.compressToBase64(title);
                body = LZString.compressToBase64(body);
                db.saveToDB(notename, title, body,
                    function (err, result) {
                        delete notes[notename];
                        if (config.debug) {
                            //logger.info(notes);
                            getStatus(function (data) {
                                logger.info(JSON.stringify(data));
                            });
                        }
                    });
            } else {
                delete notes[notename];
            }
        }
    }
    emitOnlineUsers(socket);

    //clear finished socket in queue
    for (var i = 0; i < disconnectSocketQueue.length; i++) {
        if (disconnectSocketQueue[i].id == socket.id)
            disconnectSocketQueue.splice(i, 1);
    }
    //seek for next socket
    isDisconnectBusy = false;
    if (disconnectSocketQueue.length > 0)
        disconnect(disconnectSocketQueue[0]);

    if (config.debug) {
        //logger.info(notes);
        getStatus(function (data) {
            logger.info(JSON.stringify(data));
        });
    }
}

function buildUserOutData(user) {
    var out = {
        id: user.id,
        login: user.login,
        userid: user.userid,
        color: user.color,
        cursor: user.cursor,
        name: user.name,
        idle: user.idle,
        type: user.type
    };
    return out;
}

function updateUserData(socket, user) {
    //retrieve user data from passport
    if (socket.request.user && socket.request.user.logged_in) {
        var profile = JSON.parse(socket.request.user.profile);
        /*
        var photo = null;
        switch(profile.provider) {
            case "facebook":
                console.log(profile);
                break;
            case "twitter":
                photo = profile.photos[0];
                break;
            case "github":
                photo = profile.avatar_url;
                break;
            case "dropbox":
                //not image api provided
                break;
        }
        user.photo = photo;
        */
        user.name = profile.displayName || profile.username;
        user.userid = socket.request.user._id;
        user.login = true;
    } else {
        user.userid = null;
        user.name = 'Guest ' + chance.last();
        user.login = false;
    }
}

function connection(socket) {
    //split notename from socket
    var notename = getNotenameFromSocket(socket);

    //initialize user data
    //random color
    var color = randomcolor({
        luminosity: 'light'
    });
    //make sure color not duplicated or reach max random count
    if (notename && notes[notename]) {
        var randomcount = 0;
        var maxrandomcount = 5;
        var found = false;
        do {
            Object.keys(notes[notename].users).forEach(function (user) {
                if (user.color == color) {
                    found = true;
                    return;
                }
            });
            if (found) {
                color = randomcolor({
                    luminosity: 'light'
                });
                randomcount++;
            }
        } while (found && randomcount < maxrandomcount);
    }
    //create user data
    users[socket.id] = {
        id: socket.id,
        address: socket.handshake.address,
        'user-agent': socket.handshake.headers['user-agent'],
        color: color,
        cursor: null,
        login: false,
        userid: null,
        name: null,
        idle: false,
        type: null
    };
    updateUserData(socket, users[socket.id]);

    //start connection
    connectionSocketQueue.push(socket);
    startConnection(socket);

    //received client refresh request
    socket.on('refresh', function () {
        emitRefresh(socket);
    });

    //received client data updated
    socket.on('update', function (body_) {
        var notename = getNotenameFromSocket(socket);
        if (!notename || !notes[notename]) return;
        if (config.debug)
            logger.info('SERVER received [' + notename + '] data updated: ' + socket.id);
        var note = notes[notename];
        if (note.body != body_) {
            note.body = body_;
            note.hash = md5(body_);
            note.updatetime = Date.now();
            note.isDirty = true;
        }
        var out = {
            id: socket.id,
            hash: note.hash,
            updatetime: note.updatetime
        };
        for (var i = 0, l = note.socks.length; i < l; i++) {
            var sock = note.socks[i];
            sock.emit('check', out);
        };
    });

    //received user status
    socket.on('user status', function (data) {
        var notename = getNotenameFromSocket(socket);
        if (!notename || !notes[notename]) return;
        if (config.debug)
            logger.info('SERVER received [' + notename + '] user status from [' + socket.id + ']: ' + JSON.stringify(data));
        if (data) {
            var user = users[socket.id];
            user.idle = data.idle;
            user.type = data.type;
        }
        emitUserStatus(socket);
    });

    //received note permission change request
    socket.on('permission', function (permission) {
        //need login to do more actions
        if (socket.request.user && socket.request.user.logged_in) {
            var notename = getNotenameFromSocket(socket);
            if (!notename || !notes[notename]) return;
            var note = notes[notename];
            //Only owner can change permission
            if (note.owner == socket.request.user._id) {
                note.permission = permission;
                Note.findNote(notename, function (err, _note) {
                    if (err || !_note) {
                        return;
                    }
                    Note.updatePermission(_note, permission, function (err, _note) {
                        if (err || !_note) {
                            return;
                        }
                        var out = {
                            permission: permission
                        };
                        for (var i = 0, l = note.socks.length; i < l; i++) {
                            var sock = note.socks[i];
                            sock.emit('permission', out);
                        };
                    });
                });
            }
        }
    });

    //reveiced when user logout or changed
    socket.on('user changed', function () {
        logger.info('user changed');
        var notename = getNotenameFromSocket(socket);
        if (!notename || !notes[notename]) return;
        updateUserData(socket, notes[notename].users[socket.id]);
        emitOnlineUsers(socket);
    });

    //received sync of online users request
    socket.on('online users', function () {
        var notename = getNotenameFromSocket(socket);
        if (!notename || !notes[notename]) return;
        var users = [];
        Object.keys(notes[notename].users).forEach(function (key) {
            var user = notes[notename].users[key];
            if (user)
                users.push(buildUserOutData(user));
        });
        var out = {
            users: users
        };
        out = LZString.compressToUTF16(JSON.stringify(out));
        socket.emit('online users', out);
    });

    //check version
    socket.on('version', function () {
        socket.emit('version', config.version);
    });

    //received cursor focus
    socket.on('cursor focus', function (data) {
        var notename = getNotenameFromSocket(socket);
        if (!notename || !notes[notename]) return;
        users[socket.id].cursor = data;
        var out = buildUserOutData(users[socket.id]);
        for (var i = 0, l = notes[notename].socks.length; i < l; i++) {
            var sock = notes[notename].socks[i];
            if (sock != socket) {
                sock.emit('cursor focus', out);
            }
        };
    });

    //received cursor activity
    socket.on('cursor activity', function (data) {
        var notename = getNotenameFromSocket(socket);
        if (!notename || !notes[notename]) return;
        users[socket.id].cursor = data;
        var out = buildUserOutData(users[socket.id]);
        for (var i = 0, l = notes[notename].socks.length; i < l; i++) {
            var sock = notes[notename].socks[i];
            if (sock != socket) {
                sock.emit('cursor activity', out);
            }
        };
    });

    //received cursor blur
    socket.on('cursor blur', function () {
        var notename = getNotenameFromSocket(socket);
        if (!notename || !notes[notename]) return;
        users[socket.id].cursor = null;
        var out = {
            id: socket.id
        };
        for (var i = 0, l = notes[notename].socks.length; i < l; i++) {
            var sock = notes[notename].socks[i];
            if (sock != socket) {
                sock.emit('cursor blur', out);
            }
        };
    });

    //when a new client disconnect
    socket.on('disconnect', function () {
        disconnectSocketQueue.push(socket);
        disconnect(socket);
    });

    //when received client change data request
    socket.on('change', function (op) {
        var notename = getNotenameFromSocket(socket);
        if (!notename || !notes[notename]) return;
        var note = notes[notename];
        switch (note.permission) {
        case "freely":
            //not blocking anyone
            break;
        case "editable":
            //only login user can change
            if (!socket.request.user || !socket.request.user.logged_in)
                return;
            break;
        case "locked":
            //only owner can change
            if (note.owner != socket.request.user._id)
                return;
            break;
        }
        op = LZString.decompressFromUTF16(op);
        if (op)
            op = JSON.parse(op);
        else
            return;
        if (config.debug)
            logger.info('SERVER received [' + notename + '] data changed: ' + socket.id + ', op:' + JSON.stringify(op));
        switch (op.origin) {
        case '+input':
        case '+delete':
        case '+transpose':
        case 'paste':
        case 'cut':
        case 'undo':
        case 'redo':
        case 'drag':
        case '*compose':
        case 'case':
        case '+insertLine':
        case '+swapLine':
        case '+joinLines':
        case '+duplicateLine':
        case '+sortLines':
            op.id = socket.id;
            op.otk = note.otk;
            op.nextotk = note.otk = shortId.generate();
            var stringop = JSON.stringify(op);
            var compressstringop = LZString.compressToUTF16(stringop);
            for (var i = 0, l = note.socks.length; i < l; i++) {
                var sock = note.socks[i];
                if (config.debug)
                    logger.info('SERVER emit sync data out [' + notename + ']: ' + sock.id + ', op:' + stringop);
                sock.emit('change', compressstringop);
            };
            break;
        default:
            logger.info('SERVER received uncaught [' + notename + '] data changed: ' + socket.id + ', op:' + JSON.stringify(op));
        }
    });
}

module.exports = realtime;