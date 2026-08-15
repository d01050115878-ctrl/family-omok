/* =========================================================
   가족 오목 게임 - 서버 (Express + Socket.IO)
   ========================================================= */
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

app.use(express.static(path.join(__dirname, 'public')));
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
    rematchVotes: new Set(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    disconnectTimers: {},
  };
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
    io.to(code).emit('game:start', {
      board: room.board, turn: room.turn, size: BOARD_SIZE,
      players: roomPublicPlayers(room),
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
      players: roomPublicPlayers(room),
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

    io.to(room.code).emit('game:move', {
      x, y, color: me.color, turn: room.turn,
      winner, winLine, status: room.status,
    });
  });

  socket.on('game:undo-request', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing' || !room.moves.length) return;
    room.undoRequest = { byToken: socket.data.token };
    socket.to(room.code).emit('game:undo-requested');
  });

  socket.on('game:undo-response', (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.undoRequest) return;
    const accept = !!payload.accept;
    if (accept) {
      const last = room.moves.pop();
      if (last) {
        room.board[last.y][last.x] = null;
        room.turn = last.color;
        room.status = 'playing';
        room.winner = null;
        room.winLine = null;
      }
    }
    room.undoRequest = null;
    io.to(room.code).emit('game:undo-result', {
      accepted: accept, board: room.board, turn: room.turn, status: room.status,
    });
  });

  socket.on('game:resign', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return;
    const me = playerByToken(room, socket.data.token);
    if (!me) return;
    room.status = 'ended';
    room.winner = Rules.other(me.color);
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
      // 선공/후공(색) 서로 교대
      Object.values(room.players).forEach((p) => {
        p.color = p.color === Rules.BLACK ? Rules.WHITE : Rules.BLACK;
      });
      io.to(room.code).emit('game:rematch-start', {
        board: room.board, turn: room.turn, players: roomPublicPlayers(room),
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
      if (!stillConnected) rooms.delete(code);
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
    if (now - room.lastActivity > ROOM_TTL_MS) rooms.delete(code);
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`오목 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
