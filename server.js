/* =========================================================
   가족 오목 게임 - 서버 (Express + Socket.IO)
   ========================================================= */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const Rules = require('./public/js/rules.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

const PORT = process.env.PORT || 3000;
const BOARD_SIZE = Rules.SIZE;
const MAX_UNDOS = Rules.MAX_UNDOS;
const TURN_TIME_MS = Rules.TURN_TIME_MS;

// 서버가 새로 뜰 때마다(=새 배포마다) 값이 바뀌는 버전 태그.
// index.html이 참조하는 js/css 경로 뒤에 ?v=<태그>를 붙여서, 배포 후에도 브라우저가
// 예전에 캐시해둔 스크립트를 계속 쓰는 바람에 "업데이트가 반영이 안 되는" 문제를 막는다.
const ASSET_VERSION = String(Date.now());
const INDEX_HTML = fs
  .readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace(/(src|href)="((?:css|js)\/[^"]+)"/g, (m, attr, url) => `${attr}="${url}?v=${ASSET_VERSION}"`);

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(INDEX_HTML);
});
app.get('/healthz', (req, res) => res.send('ok'));

/** @type {Map<string, Room>} */
const rooms = new Map();
const ROOM_TTL_MS = 10 * 60 * 1000; // 상대 없이 방치되면 10분 후 정리
const RECONNECT_GRACE_MS = 10 * 60 * 1000; // 브라우저를 닫았다 다시 열어도 이어할 수 있도록 넉넉하게

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function genToken() {
  return crypto.randomBytes(12).toString('hex');
}

function makeRoom(code) {
  return {
    code,
    board: Rules.createBoard(BOARD_SIZE),
    turn: Rules.BLACK,
    moves: [], // {x,y,color}
    players: {}, // token -> {token,name,avatar,color,socketId,connected}
    status: 'waiting', // waiting | playing | ended
    winner: null,
    winLine: null,
    undoRequest: null, // {byToken}
    undoCounts: { [Rules.BLACK]: 0, [Rules.WHITE]: 0 }, // 색깔별로 사용한 무르기 횟수
    rematchVotes: new Set(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    disconnectTimers: {},
    turnTimer: null,
    turnDeadline: null,
  };
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

// 현재 차례(room.turn)를 기준으로 제한 시간을 새로 건다. 시간이 다 되면
// 돌을 놓지 않은 채로 상대 턴으로 넘기고, 다음 차례의 타이머를 다시 건다.
function scheduleTurnTimer(room) {
  clearTurnTimer(room);
  if (room.status !== 'playing') {
    room.turnDeadline = null;
    return;
  }
  room.turnDeadline = Date.now() + TURN_TIME_MS;
  const turnAtSchedule = room.turn;
  room.turnTimer = setTimeout(() => {
    if (room.status !== 'playing' || room.turn !== turnAtSchedule) return;
    room.turn = Rules.other(room.turn);
    room.undoRequest = null;
    touch(room);
    scheduleTurnTimer(room);
    io.to(room.code).emit('game:turn-timeout', { turn: room.turn, turnDeadline: room.turnDeadline });
  }, TURN_TIME_MS);
}

function roomPublicPlayers(room) {
  return Object.values(room.players).map((p) => ({
    token: p.token, name: p.name, avatar: p.avatar, color: p.color, connected: !!p.connected,
  }));
}

function touch(room) {
  room.lastActivity = Date.now();
}

function playerByToken(room, token) {
  return room.players[token];
}

function opponentOf(room, token) {
  return Object.values(room.players).find((p) => p.token !== token);
}

function broadcastState(room, event, extra) {
  io.to(room.code).emit(event, Object.assign({
    players: roomPublicPlayers(room),
  }, extra || {}));
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.token = null;

  socket.on('room:create', (payload = {}, cb) => {
    try {
      const code = genCode();
      const room = makeRoom(code);
      const token = genToken();
      let color = payload.side;
      if (color !== Rules.BLACK && color !== Rules.WHITE) {
        color = Math.random() < 0.5 ? Rules.BLACK : Rules.WHITE;
      }
      room.players[token] = {
        token, name: (payload.name || '플레이어').slice(0, 12), avatar: payload.avatar || '🙂',
        color, socketId: socket.id, connected: true,
      };
      rooms.set(code, room);

      socket.join(code);
      socket.data.roomCode = code;
      socket.data.token = token;

      cb && cb({ ok: true, code, token, color, size: BOARD_SIZE, players: roomPublicPlayers(room) });
    } catch (err) {
      cb && cb({ ok: false, message: '방을 만들지 못했어요. 다시 시도해주세요.' });
    }
  });

  socket.on('room:join', (payload = {}, cb) => {
    const code = String(payload.code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb && cb({ ok: false, message: '방을 찾을 수 없어요. 코드를 확인해주세요.' });
    if (Object.keys(room.players).length >= 2) {
      return cb && cb({ ok: false, message: '이미 두 명이 입장한 방이에요.' });
    }

    const existingColor = Object.values(room.players)[0]?.color;
    const color = existingColor === Rules.BLACK ? Rules.WHITE : Rules.BLACK;
    const token = genToken();
    room.players[token] = {
      token, name: (payload.name || '플레이어').slice(0, 12), avatar: payload.avatar || '🙂',
      color, socketId: socket.id, connected: true,
    };

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.token = token;
    touch(room);

    cb && cb({ ok: true, code, token, color, size: BOARD_SIZE, players: roomPublicPlayers(room) });

    room.status = 'playing';
    scheduleTurnTimer(room);
    io.to(code).emit('game:start', {
      board: room.board, turn: room.turn, size: BOARD_SIZE,
      players: roomPublicPlayers(room), undoCounts: room.undoCounts, turnDeadline: room.turnDeadline,
    });
  });

  socket.on('room:rejoin', (payload = {}, cb) => {
    const code = String(payload.code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room || !room.players[payload.token]) {
      return cb && cb({ ok: false, message: '방에 다시 들어갈 수 없어요.' });
    }
    const p = room.players[payload.token];
    p.socketId = socket.id;
    p.connected = true;
    if (room.disconnectTimers[payload.token]) {
      clearTimeout(room.disconnectTimers[payload.token]);
      delete room.disconnectTimers[payload.token];
    }
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.token = payload.token;

    cb && cb({
      ok: true, code, token: p.token, color: p.color, size: BOARD_SIZE,
      board: room.board, turn: room.turn, status: room.status,
      winner: room.winner, winLine: room.winLine,
      players: roomPublicPlayers(room), undoCounts: room.undoCounts, turnDeadline: room.turnDeadline,
    });
    socket.to(code).emit('room:opponent-reconnected', { players: roomPublicPlayers(room) });
  });

  socket.on('game:move', (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return;
    const me = playerByToken(room, socket.data.token);
    if (!me || me.color !== room.turn) return;
    const { x, y } = payload;
    if (!Rules.isValidMove(room.board, x, y, BOARD_SIZE)) return;
    if (Rules.isForbiddenMove(room.board, x, y, me.color, BOARD_SIZE)) {
      socket.emit('game:move-rejected', { x, y, reason: 'forbidden-33' });
      return;
    }

    room.board[y][x] = me.color;
    room.moves.push({ x, y, color: me.color });
    touch(room);

    const result = Rules.checkWin(room.board, x, y, me.color, BOARD_SIZE);
    let winner = null, winLine = null;
    if (result.win) {
      winner = me.color;
      winLine = result.line;
      room.status = 'ended';
      room.winner = winner;
      room.winLine = winLine;
    } else if (Rules.isBoardFull(room.board)) {
      room.status = 'ended';
      room.winner = 'draw';
    } else {
      room.turn = Rules.other(room.turn);
    }
    room.undoRequest = null;
    scheduleTurnTimer(room);

    io.to(room.code).emit('game:move', {
      x, y, color: me.color, turn: room.turn,
      winner, winLine, status: room.status, turnDeadline: room.turnDeadline,
    });
  });

  socket.on('game:undo-request', (payload, cb) => {
    if (typeof payload === 'function') { cb = payload; payload = {}; }
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing' || !room.moves.length) return;
    const me = playerByToken(room, socket.data.token);
    if (!me) return;
    if (room.undoCounts[me.color] >= MAX_UNDOS) {
      cb && cb({ ok: false, message: `무르기는 한 판에 ${MAX_UNDOS}번까지만 할 수 있어요` });
      return;
    }
    room.undoRequest = { byToken: socket.data.token };
    cb && cb({ ok: true });
    socket.to(room.code).emit('game:undo-requested');
  });

  socket.on('game:undo-response', (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.undoRequest) return;
    const accept = !!payload.accept;
    if (accept) {
      const requester = playerByToken(room, room.undoRequest.byToken);
      const last = room.moves.pop();
      if (last) {
        room.board[last.y][last.x] = null;
        room.turn = last.color;
        room.status = 'playing';
        room.winner = null;
        room.winLine = null;
      }
      if (requester) room.undoCounts[requester.color] = (room.undoCounts[requester.color] || 0) + 1;
      scheduleTurnTimer(room);
    }
    room.undoRequest = null;
    io.to(room.code).emit('game:undo-result', {
      accepted: accept, board: room.board, turn: room.turn, status: room.status,
      undoCounts: room.undoCounts, turnDeadline: room.turnDeadline,
    });
  });

  socket.on('game:resign', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return;
    const me = playerByToken(room, socket.data.token);
    if (!me) return;
    room.status = 'ended';
    room.winner = Rules.other(me.color);
    clearTurnTimer(room);
    room.turnDeadline = null;
    io.to(room.code).emit('game:resigned', { by: me.color, winner: room.winner });
  });

  socket.on('game:rematch-request', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    room.rematchVotes.add(socket.data.token);
    socket.to(room.code).emit('game:rematch-requested');
    if (room.rematchVotes.size >= 2) {
      room.board = Rules.createBoard(BOARD_SIZE);
      room.moves = [];
      room.turn = Rules.BLACK;
      room.status = 'playing';
      room.winner = null;
      room.winLine = null;
      room.rematchVotes.clear();
      room.undoCounts = { [Rules.BLACK]: 0, [Rules.WHITE]: 0 };
      // 선공/후공(색) 서로 교대
      Object.values(room.players).forEach((p) => {
        p.color = p.color === Rules.BLACK ? Rules.WHITE : Rules.BLACK;
      });
      scheduleTurnTimer(room);
      io.to(room.code).emit('game:rematch-start', {
        board: room.board, turn: room.turn, players: roomPublicPlayers(room), undoCounts: room.undoCounts,
        turnDeadline: room.turnDeadline,
      });
    }
  });

  socket.on('chat:message', (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const me = playerByToken(room, socket.data.token);
    if (!me) return;
    const text = String(payload.text || '').slice(0, 200);
    if (!text.trim()) return;
    io.to(room.code).emit('chat:message', { name: me.name, color: me.color, text, ts: Date.now() });
  });

  socket.on('chat:emote', (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const me = playerByToken(room, socket.data.token);
    if (!me) return;
    const emoji = String(payload.emoji || '').slice(0, 8);
    if (!emoji) return;
    io.to(room.code).emit('chat:emote', { name: me.name, color: me.color, emoji });
  });

  socket.on('room:leave', () => cleanupSocket(socket, true));
  socket.on('disconnect', () => cleanupSocket(socket, false));

  function cleanupSocket(socket, explicit) {
    const code = socket.data.roomCode;
    const token = socket.data.token;
    if (!code || !rooms.has(code)) return;
    const room = rooms.get(code);
    const me = playerByToken(room, token);
    if (!me) return;

    me.connected = false;
    socket.leave(code);
    socket.to(code).emit('room:opponent-disconnected', { players: roomPublicPlayers(room) });

    const finalize = () => {
      const stillConnected = Object.values(room.players).some((p) => p.connected);
      if (!stillConnected) {
        clearTurnTimer(room);
        rooms.delete(code);
      }
    };

    if (explicit) {
      delete room.players[token];
      finalize();
    } else {
      room.disconnectTimers[token] = setTimeout(() => {
        if (room.players[token] && !room.players[token].connected) {
          delete room.players[token];
        }
        finalize();
      }, RECONNECT_GRACE_MS);
    }
  }
});

// 오래된 빈 방 정리
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      clearTurnTimer(room);
      rooms.delete(code);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`오목 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
