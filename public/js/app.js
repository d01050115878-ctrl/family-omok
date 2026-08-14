/* =========================================================
   우리 가족 오목 게임 - 프론트엔드 앱 로직
   ========================================================= */
(function () {
  'use strict';

  const R = window.OmokRules;
  const AI = window.OmokAI;
  const SIZE = R.SIZE;

  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

  const AVATARS = ['🙂', '🐯', '🐰', '🐻', '🦊', '🐼', '🐵', '🦁', '🐶', '🐱', '🐸', '🐷', '🦄', '👧', '👦', '🧔', '👩', '👨', '👵', '👴', '🐔'];
  const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'O', 'P'];
  const QUICK_MSGS = ['안녕하세요! 👋', '잘 부탁드려요 🙏', '좋은 수네요! 👍', '이런! 😲', '다시 생각해볼게요 🤔', '축하해요! 🎉', '재밌어요! 😄', '한 판 더 해요!'];
  const EMOTES = ['👍', '😄', '😮', '🔥', '🤔', '🎉', '😭', '💪'];

  /* ---------------- 전역 상태 ---------------- */
  const state = {
    mode: null,           // 'ai' | 'local' | 'online'
    board: R.createBoard(SIZE),
    turn: R.BLACK,
    status: 'idle',       // idle | playing | ended
    moves: [],
    winner: null,
    winLine: null,
    aiLevel: 2,
    mySide: R.BLACK,      // ai 모드에서 내 돌 색
    players: {
      black: { name: '흑돌', avatar: '⚫' },
      white: { name: '백돌', avatar: '⚪' },
    },
    flipped: false,
    reviewing: false,
    reviewIndex: 0,
    settings: { helper: true, coach: true, sound: true },
    profile: { name: '', avatar: '🙂' },
    online: { code: null, token: null, myColor: null, connected: false },
    aiThinking: false,
    hintMark: null,   // {x, y} — 다음 수를 둘 때까지 계속 표시
  };

  /* ---------------- 유틸 ---------------- */
  function showScreen(id) {
    $$('.screen').forEach((s) => s.classList.remove('active'));
    $('#' + id).classList.add('active');
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  function showModal({ emoji, title, text, actions }) {
    $('#modalEmoji').textContent = emoji || '🎉';
    $('#modalTitle').textContent = title || '';
    $('#modalText').textContent = text || '';
    const wrap = $('#modalActions');
    wrap.innerHTML = '';
    (actions || []).forEach((a) => {
      const btn = document.createElement('button');
      btn.className = a.cls || 'ghost';
      btn.textContent = a.label;
      btn.onclick = () => { hideModal(); a.onClick && a.onClick(); };
      wrap.appendChild(btn);
    });
    $('#modalBack').classList.remove('hidden');
  }
  function hideModal() { $('#modalBack').classList.add('hidden'); }

  function colorName(c) { return c === R.BLACK ? '흑돌' : '백돌'; }
  function colorStone(c) { return c === R.BLACK ? '⚫' : '⚪'; }
  function otherColor(c) { return R.other(c); }

  /* ---------------- 사운드 ---------------- */
  let audioCtx = null;
  function beep(freq, dur, type) {
    if (!state.settings.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + dur);
    } catch (e) { /* 무시 */ }
  }
  const sndPlace = () => beep(420, 0.12, 'sine');
  const sndWin = () => { beep(660, 0.18, 'triangle'); setTimeout(() => beep(880, 0.25, 'triangle'), 150); };
  const sndClick = () => beep(300, 0.06, 'square');

  /* ---------------- 프로필 / 아바타 ---------------- */
  function loadProfile() {
    try {
      const raw = localStorage.getItem('omok_profile');
      if (raw) Object.assign(state.profile, JSON.parse(raw));
    } catch (e) { /* 무시 */ }
    $('#playerName').value = state.profile.name || '';
    $('#myAvatar').textContent = state.profile.avatar || '🙂';
  }
  function saveProfile() {
    state.profile.name = $('#playerName').value.trim();
    localStorage.setItem('omok_profile', JSON.stringify(state.profile));
  }

  function buildAvatarPicker(container, onPick) {
    container.innerHTML = '';
    AVATARS.forEach((a) => {
      const b = document.createElement('button');
      b.textContent = a;
      b.onclick = () => { onPick(a); container.classList.add('hidden'); };
      container.appendChild(b);
    });
  }

  /* ---------------- 화면 내비게이션 ---------------- */
  $$('[data-go]').forEach((btn) => {
    btn.addEventListener('click', () => showScreen(btn.dataset.go));
  });

  $('#myAvatarBtn').addEventListener('click', () => {
    const p = $('#avatarPicker');
    p.classList.toggle('hidden');
    buildAvatarPicker(p, (a) => { state.profile.avatar = a; $('#myAvatar').textContent = a; saveProfile(); });
  });
  $('#playerName').addEventListener('change', saveProfile);
  $('#playerName').addEventListener('blur', saveProfile);

  $('#optHelper').addEventListener('change', (e) => state.settings.helper = e.target.checked);
  $('#optCoach').addEventListener('change', (e) => state.settings.coach = e.target.checked);
  $('#optSound').addEventListener('change', (e) => state.settings.sound = e.target.checked);

  /* ---------------- AI 화면 ---------------- */
  $$('#levelGrid .level-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#levelGrid .level-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.aiLevel = Number(btn.dataset.level);
    });
  });
  $$('#sideGridAi .side-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#sideGridAi .side-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });
  $('#startAi').addEventListener('click', () => {
    saveProfile();
    let side = $('#sideGridAi .side-btn.selected').dataset.side;
    if (side === 'random') side = Math.random() < 0.5 ? R.BLACK : R.WHITE;
    state.mySide = side;
    const me = { name: state.profile.name || '나', avatar: state.profile.avatar || '🙂' };
    const cpu = { name: '컴퓨터', avatar: '🤖' };
    state.players.black = side === R.BLACK ? me : cpu;
    state.players.white = side === R.WHITE ? me : cpu;
    startGame('ai');
  });

  /* ---------------- 로컬 2인 화면 ---------------- */
  let localAvatars = { black: '🐯', white: '🐰' };
  $('#blackAvatarBtn').addEventListener('click', () => {
    const p = $('#avatarPicker'); p.classList.remove('hidden');
    buildAvatarPicker(p, (a) => { localAvatars.black = a; $('#blackAvatar').textContent = a; });
  });
  $('#whiteAvatarBtn').addEventListener('click', () => {
    const p = $('#avatarPicker'); p.classList.remove('hidden');
    buildAvatarPicker(p, (a) => { localAvatars.white = a; $('#whiteAvatar').textContent = a; });
  });
  $('#startLocal').addEventListener('click', () => {
    state.players.black = { name: $('#localBlackName').value.trim() || '흑돌 플레이어', avatar: localAvatars.black };
    state.players.white = { name: $('#localWhiteName').value.trim() || '백돌 플레이어', avatar: localAvatars.white };
    startGame('local');
  });

  /* ---------------- 온라인 화면 ---------------- */
  let socket = null;
  function ensureSocket() {
    if (socket) return socket;
    socket = io();
    wireSocketEvents();
    return socket;
  }

  $$('#sideGridOnline .side-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#sideGridOnline .side-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  $('#createRoom').addEventListener('click', () => {
    saveProfile();
    ensureSocket();
    const side = $('#sideGridOnline .side-btn.selected').dataset.side;
    $('#netStatus').textContent = '';
    socket.emit('room:create', {
      name: state.profile.name || '플레이어', avatar: state.profile.avatar || '🙂', side,
    }, (res) => {
      if (!res.ok) { $('#netStatus').textContent = res.message; return; }
      state.online.code = res.code;
      state.online.token = res.token;
      state.online.myColor = res.color;
      sessionStorage.setItem('omok_room', JSON.stringify({ code: res.code, token: res.token }));
      $('#roomCode').textContent = res.code;
      $('#waitingBox').classList.remove('hidden');
    });
  });

  $('#joinRoom').addEventListener('click', () => {
    saveProfile();
    ensureSocket();
    const code = $('#joinCode').value.trim().toUpperCase();
    if (code.length < 4) { $('#netStatus').textContent = '초대 코드를 확인해주세요.'; return; }
    $('#netStatus').textContent = '';
    socket.emit('room:join', {
      code, name: state.profile.name || '플레이어', avatar: state.profile.avatar || '🙂',
    }, (res) => {
      if (!res.ok) { $('#netStatus').textContent = res.message; return; }
      state.online.code = res.code;
      state.online.token = res.token;
      state.online.myColor = res.color;
      sessionStorage.setItem('omok_room', JSON.stringify({ code: res.code, token: res.token }));
    });
  });

  function inviteUrl() {
    return `${location.origin}/?code=${state.online.code}`;
  }
  function inviteText() {
    return `⚫⚪ 오목 한 판 하실래요? 초대 코드: ${state.online.code}\n${inviteUrl()}`;
  }

  function copyText(text, successMsg) {
    const done = () => toast(successMsg);
    const fail = () => {
      // 클립보드 API를 못 쓰는 환경 대비: 직접 선택해서 복사할 수 있게 보여준다
      window.prompt('아래 내용을 직접 복사해주세요', text);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fail);
    } else {
      fail();
    }
  }

  $('#shareInvite').addEventListener('click', () => {
    if (navigator.share) {
      navigator.share({
        title: '우리 가족 오목 게임',
        text: `⚫⚪ 오목 한 판 하실래요? 초대 코드: ${state.online.code}`,
        url: inviteUrl(),
      }).catch(() => { /* 사용자가 공유 취소한 경우 등 — 무시 */ });
    } else {
      copyText(inviteText(), '초대 메시지를 복사했어요! 카톡이나 문자에 붙여넣어 보내주세요');
    }
  });
  $('#copyCode').addEventListener('click', () => {
    copyText(state.online.code || '', '코드를 복사했어요!');
  });
  $('#copyLink').addEventListener('click', () => {
    copyText(inviteUrl(), '초대 링크를 복사했어요!');
  });
  $('#cancelRoom').addEventListener('click', () => {
    socket && socket.emit('room:leave');
    sessionStorage.removeItem('omok_room');
    $('#waitingBox').classList.add('hidden');
    state.online = { code: null, token: null, myColor: null, connected: false };
  });

  function wireSocketEvents() {
    socket.on('connect', () => { state.online.connected = true; });
    socket.on('disconnect', () => { state.online.connected = false; });

    socket.on('game:start', (payload) => {
      $('#waitingBox').classList.add('hidden');
      const meColor = state.online.myColor;
      const oppP = payload.players.find((p) => p.color !== meColor);
      const meP = payload.players.find((p) => p.color === meColor);
      state.players.black = meColor === R.BLACK ? profileOf(meP) : profileOf(oppP);
      state.players.white = meColor === R.WHITE ? profileOf(meP) : profileOf(oppP);
      state.board = payload.board;
      state.turn = payload.turn;
      state.moves = [];
      state.mySide = meColor;
      startGame('online', true);
      toast('상대방과 연결됐어요! 게임 시작 🎉');
    });

    socket.on('game:move', (payload) => {
      state.board[payload.y][payload.x] = payload.color;
      state.moves.push({ x: payload.x, y: payload.y, color: payload.color });
      state.turn = payload.turn;
      renderBoard();
      appendMoveLog(state.moves.length - 1);
      if (payload.status === 'ended') {
        state.status = 'ended';
        state.winner = payload.winner;
        state.winLine = payload.winLine;
        onGameEnd();
      } else {
        updateTurnUI();
      }
    });

    socket.on('game:undo-requested', () => {
      showModal({
        emoji: '↩️', title: '무르기 요청', text: '상대방이 무르기를 요청했어요. 받아줄까요?',
        actions: [
          { label: '거절할래요', cls: 'ghost', onClick: () => socket.emit('game:undo-response', { accept: false }) },
          { label: '받아줄게요', cls: 'primary', onClick: () => socket.emit('game:undo-response', { accept: true }) },
        ],
      });
    });
    socket.on('game:undo-result', (payload) => {
      state.board = payload.board;
      state.turn = payload.turn;
      state.status = payload.status;
      state.hintMark = null;
      if (payload.accepted) {
        state.moves.pop();
        toast('무르기를 받아들였어요');
      } else {
        toast('무르기가 거절됐어요');
      }
      renderBoard();
      rebuildMoveLog();
      updateTurnUI();
    });

    socket.on('game:resigned', (payload) => {
      state.status = 'ended';
      state.winner = payload.winner;
      state.winLine = null;
      onGameEnd(true);
    });

    socket.on('game:rematch-requested', () => toast('상대방이 재대결을 요청했어요. 재대결 버튼을 눌러주세요!'));
    socket.on('game:rematch-start', (payload) => {
      const meColor = payload.players.find((p) => p.token === state.online.token)?.color;
      state.online.myColor = meColor;
      state.mySide = meColor;
      state.board = payload.board;
      state.turn = payload.turn;
      state.moves = [];
      state.status = 'playing';
      state.winner = null;
      state.winLine = null;
      state.hintMark = null;
      hideModal();
      resetGameScreenUI();
      renderBoard();
      updateTurnUI();
      toast('재대결이 시작됐어요!');
    });

    socket.on('room:opponent-disconnected', () => toast('상대방의 연결이 끊겼어요. 잠시 기다려볼게요...'));
    socket.on('room:opponent-reconnected', () => toast('상대방이 다시 연결됐어요!'));

    socket.on('chat:message', (payload) => addChatMessage(payload.name, payload.text, payload.color === state.mySide));
    socket.on('chat:emote', (payload) => { flyEmote(payload.emoji); addChatMessage(payload.name, payload.emoji, payload.color === state.mySide, true); });
  }

  function profileOf(p) { return { name: p ? p.name : '상대', avatar: p ? p.avatar : '🙂' }; }

  // 초대 링크(?code=XXXXXX)로 들어온 경우 자동으로 참가 코드 입력
  (function handleInviteLink() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (code) {
      showScreen('screen-online');
      $('#joinCode').value = code.toUpperCase();
    }
  })();

  /* ---------------- 게임 시작/초기화 ---------------- */
  function startGame(mode, skipReset) {
    state.mode = mode;
    state.hintMark = null;
    if (!skipReset) {
      state.board = R.createBoard(SIZE);
      state.turn = R.BLACK;
      state.moves = [];
      state.status = 'playing';
      state.winner = null;
      state.winLine = null;
    } else {
      state.status = 'playing';
    }
    state.flipped = mode === 'online' && state.mySide === R.WHITE;
    resetGameScreenUI();
    initBoardDOM();
    renderBoard();
    updateTurnUI();
    showScreen('screen-game');

    const chatEnabled = mode === 'online';
    $('#chatText').disabled = !chatEnabled;
    $('#chatSend').disabled = !chatEnabled;
    $('#chatText').placeholder = chatEnabled ? '메시지 보내기' : '온라인 대국에서만 대화할 수 있어요';
    $('#chatList').innerHTML = '';
    buildQuickMsgs();

    if (mode === 'ai' && state.turn !== state.mySide) {
      scheduleAiMove();
    }
  }

  function resetGameScreenUI() {
    $('#winBanner').classList.add('hidden');
    $('#coachPop').classList.add('hidden');
    $('#reviewBar').classList.add('hidden');
    $('#emoteBar').classList.add('hidden');
    $('#moreMenu').classList.add('hidden');
    $('#moveLog').innerHTML = '';
    state.reviewing = false;
    $('#btnChat').classList.toggle('hidden', state.mode !== 'online');
    $('#btnUndo').classList.remove('hidden');
  }

  function buildQuickMsgs() {
    const wrap = $('#quickMsgs');
    wrap.innerHTML = '';
    QUICK_MSGS.forEach((m) => {
      const b = document.createElement('button');
      b.textContent = m;
      b.onclick = () => sendChat(m);
      wrap.appendChild(b);
    });
  }

  /* ---------------- 보드 렌더링 ---------------- */
  function toDisplay(x, y) {
    return state.flipped ? { dx: SIZE - 1 - x, dy: SIZE - 1 - y } : { dx: x, dy: y };
  }
  function fromDisplay(dx, dy) {
    return state.flipped ? { x: SIZE - 1 - dx, y: SIZE - 1 - dy } : { x: dx, y: dy };
  }
  function pct(i) { return (i / (SIZE - 1)) * 100 + '%'; }

  function initBoardDOM() {
    const svg = $('#boardLines');
    svg.innerHTML = '';
    for (let i = 0; i < SIZE; i++) {
      svg.insertAdjacentHTML('beforeend', `<line x1="0" y1="${i}" x2="${SIZE - 1}" y2="${i}"></line>`);
      svg.insertAdjacentHTML('beforeend', `<line x1="${i}" y1="0" x2="${i}" y2="${SIZE - 1}"></line>`);
    }

    const stars = $('#stars');
    stars.innerHTML = '';
    [3, 7, 11].forEach((yi) => [3, 7, 11].forEach((xi) => {
      const s = document.createElement('div');
      s.className = 'star-pt';
      s.style.left = pct(xi); s.style.top = pct(yi);
      stars.appendChild(s);
    }));

    const click = $('#clickLayer');
    click.innerHTML = '';
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const b = document.createElement('button');
        b.className = 'click-pt';
        b.style.left = pct(x); b.style.top = pct(y);
        b.dataset.dx = x; b.dataset.dy = y;
        b.addEventListener('click', onBoardClick);
        click.appendChild(b);
      }
    }
  }

  function onBoardClick(e) {
    if (state.reviewing || state.status !== 'playing' || state.aiThinking) return;
    const dx = Number(e.currentTarget.dataset.dx);
    const dy = Number(e.currentTarget.dataset.dy);
    const { x, y } = fromDisplay(dx, dy);
    if (!R.isValidMove(state.board, x, y, SIZE)) return;

    if (state.mode === 'ai') {
      if (state.turn !== state.mySide) return;
      humanMove(x, y);
    } else if (state.mode === 'local') {
      humanMove(x, y);
    } else if (state.mode === 'online') {
      if (state.turn !== state.mySide) return;
      socket.emit('game:move', { x, y });
    }
  }

  function humanMove(x, y) {
    const color = state.turn;
    const boardBefore = R.cloneBoard(state.board);
    applyMove(x, y, color);
    sndPlace();

    if (state.settings.coach && (state.mode === 'local' || (state.mode === 'ai' && color === state.mySide))) {
      const q = AI.evaluateMoveQuality(boardBefore, x, y, color, SIZE);
      showCoach(q.quality);
    }

    if (state.status === 'ended') { onGameEnd(); return; }

    if (state.mode === 'ai' && state.turn !== state.mySide) {
      scheduleAiMove();
    }
  }

  function applyMove(x, y, color) {
    state.hintMark = null;
    state.board[y][x] = color;
    state.moves.push({ x, y, color });
    const result = R.checkWin(state.board, x, y, color, SIZE);
    if (result.win) {
      state.status = 'ended';
      state.winner = color;
      state.winLine = result.line;
    } else if (R.isBoardFull(state.board)) {
      state.status = 'ended';
      state.winner = 'draw';
    } else {
      state.turn = otherColor(color);
    }
    renderBoard();
    appendMoveLog(state.moves.length - 1);
    updateTurnUI();
  }

  function scheduleAiMove() {
    state.aiThinking = true;
    setTimeout(() => {
      if (state.status !== 'playing') { state.aiThinking = false; return; }
      const level = state.aiLevel;
      const aiColor = state.turn;
      const mv = AI.getMove(state.board, aiColor, level, SIZE);
      state.aiThinking = false;
      if (!mv) return;
      applyMove(mv.x, mv.y, aiColor);
      if (state.status === 'ended') onGameEnd();
    }, 450 + Math.random() * 350);
  }

  function renderBoard() {
    const layer = $('#stones');
    layer.innerHTML = '';
    const winSet = new Set((state.winLine || []).map(([x, y]) => x + ',' + y));
    const lastMove = state.moves[state.moves.length - 1];

    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const c = state.board[y][x];
        if (!c) continue;
        const { dx, dy } = toDisplay(x, y);
        const s = document.createElement('div');
        s.className = 'stone ' + c;
        if (lastMove && lastMove.x === x && lastMove.y === y) s.classList.add('last-move');
        if (winSet.has(x + ',' + y)) s.classList.add('win-stone');
        s.style.left = pct(dx); s.style.top = pct(dy);
        layer.appendChild(s);
      }
    }

    if (state.hintMark) {
      const { dx, dy } = toDisplay(state.hintMark.x, state.hintMark.y);
      const mark = document.createElement('div');
      mark.className = 'hint-mark';
      mark.style.left = pct(dx); mark.style.top = pct(dy);
      layer.appendChild(mark);
    }
  }

  function updateTurnUI() {
    const black = state.players.black, white = state.players.white;
    const bottomColor = state.flipped ? R.WHITE : R.BLACK;
    const topColor = otherColor(bottomColor);
    const bottomP = bottomColor === R.BLACK ? black : white;
    const topP = topColor === R.BLACK ? black : white;

    $('#avatarBottom').textContent = bottomP.avatar;
    $('#barBottom .pname').textContent = bottomP.name;
    $('#stoneTagBottom').textContent = colorStone(bottomColor);
    $('#avatarTop').textContent = topP.avatar;
    $('#barTop .pname').textContent = topP.name;
    $('#stoneTagTop').textContent = colorStone(topColor);

    $('#barBottom').classList.toggle('turn', state.turn === bottomColor && state.status === 'playing');
    $('#barTop').classList.toggle('turn', state.turn === topColor && state.status === 'playing');

    if (state.status === 'playing') {
      $('#turnBar').textContent = `${colorStone(state.turn)} ${colorName(state.turn)} 차례예요`;
    }
  }

  function appendMoveLog(idx) {
    const mv = state.moves[idx];
    if (!mv) return;
    const li = document.createElement('li');
    const label = `${COLS[mv.x]}${SIZE - mv.y}`;
    li.innerHTML = `<span>${idx + 1}. ${colorStone(mv.color)} ${colorName(mv.color)}</span><span>${label}</span>`;
    li.dataset.idx = idx;
    $('#moveLog').appendChild(li);
    $('#moveLog').scrollTop = $('#moveLog').scrollHeight;
  }
  function rebuildMoveLog() {
    $('#moveLog').innerHTML = '';
    state.moves.forEach((_, i) => appendMoveLog(i));
  }

  /* ---------------- 코치 ---------------- */
  const COACH_MSG = {
    great: ['최고의 수예요! 👏', '완벽해요! 🌟', '정말 잘 뒀어요! 🔥'],
    good: ['좋은 수예요! 😊', '괜찮은 선택이에요!'],
    ok: ['무난한 수예요', '계속 진행해볼까요?'],
    bad: ['다른 자리가 더 좋았을 수도 있어요 🤔', '조금 더 신중하게 생각해봐요'],
  };
  function showCoach(quality) {
    const list = COACH_MSG[quality] || COACH_MSG.ok;
    const msg = list[Math.floor(Math.random() * list.length)];
    const el = $('#coachPop');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 1800);
  }

  /* ---------------- 게임 종료 ---------------- */
  function onGameEnd(skipRender) {
    sndWin();
    if (!skipRender) renderBoard();
    let title, text, emoji;
    if (state.winner === 'draw') {
      emoji = '🤝'; title = '무승부!'; text = '판이 가득 찼어요. 다음엔 꼭 이겨봐요!';
    } else {
      const winnerP = state.players[state.winner];
      emoji = colorStone(state.winner);
      title = `${winnerP.name} 승리!`;
      text = `${colorName(state.winner)}이 다섯 줄을 완성했어요! 🎉`;
    }
    $('#winBanner').textContent = title;
    $('#winBanner').classList.remove('hidden');

    const actions = [
      { label: '🏠 처음으로', cls: 'ghost', onClick: goHome },
    ];
    if (state.mode === 'online') {
      actions.unshift({ label: '🔁 재대결', cls: 'primary', onClick: () => { socket.emit('game:rematch-request'); toast('재대결을 요청했어요. 상대방을 기다리는 중...'); } });
    } else {
      actions.unshift({ label: '🔁 다시하기', cls: 'primary', onClick: () => startGame(state.mode) });
    }
    showModal({ emoji, title, text, actions });
  }

  /* ---------------- 컨트롤 버튼 ---------------- */
  $('#btnUndo').addEventListener('click', () => {
    if (state.reviewing) return;
    if (state.mode === 'online') {
      if (!state.moves.length) return;
      socket.emit('game:undo-request');
      toast('무르기를 요청했어요. 상대방의 응답을 기다려요...');
      return;
    }
    if (!state.moves.length || state.aiThinking) return;
    if (state.mode === 'ai') {
      // 내 수 + AI 수를 함께 되돌려 다시 내 차례로
      state.moves.pop();
      if (state.moves.length && state.moves[state.moves.length - 1].color === state.mySide) {
        state.moves.pop();
      }
    } else {
      state.moves.pop();
    }
    rebuildBoardFromMoves();
    state.status = 'playing';
    state.winner = null; state.winLine = null;
    state.hintMark = null;
    $('#winBanner').classList.add('hidden');
    renderBoard(); rebuildMoveLog(); updateTurnUI();
    toast('한 수 물렀어요');
  });

  function rebuildBoardFromMoves() {
    state.board = R.createBoard(SIZE);
    state.moves.forEach((m) => { state.board[m.y][m.x] = m.color; });
    state.turn = state.moves.length ? otherColor(state.moves[state.moves.length - 1].color) : R.BLACK;
  }

  $('#btnHint').addEventListener('click', () => {
    if (state.reviewing || state.status !== 'playing') return;
    let who = state.turn;
    if (state.mode === 'ai' && who !== state.mySide) return;
    if (state.mode === 'online' && who !== state.mySide) return;
    const hint = AI.getHint(state.board, who, SIZE);
    if (!hint) return;
    state.hintMark = hint;
    renderBoard();
    sndClick();
  });

  $('#btnMore').addEventListener('click', () => {
    $('#moreMenu').classList.toggle('hidden');
  });
  $$('#moreMenu .ctrl').forEach((btn) => {
    btn.addEventListener('click', () => $('#moreMenu').classList.add('hidden'));
  });

  $('#btnFlip').addEventListener('click', () => {
    state.flipped = !state.flipped;
    renderBoard(); updateTurnUI();
  });

  $('#btnResign').addEventListener('click', () => {
    if (state.status !== 'playing') return;
    showModal({
      emoji: '🏳️', title: '항복할까요?', text: '지금 항복하면 상대방이 승리해요.',
      actions: [
        { label: '아니요', cls: 'ghost' },
        {
          label: '네, 항복할게요', cls: 'primary', onClick: () => {
            if (state.mode === 'online') { socket.emit('game:resign'); return; }
            state.status = 'ended';
            if (state.mode === 'ai') state.winner = otherColor(state.mySide);
            else state.winner = otherColor(state.turn);
            onGameEnd();
          },
        },
      ],
    });
  });

  $('#btnHome').addEventListener('click', () => {
    showModal({
      emoji: '🏠', title: '나가시겠어요?', text: '진행 중인 대국에서 나가요.',
      actions: [
        { label: '취소', cls: 'ghost' },
        { label: '나가기', cls: 'primary', onClick: goHome },
      ],
    });
  });

  function goHome() {
    if (state.mode === 'online' && socket) {
      socket.emit('room:leave');
      sessionStorage.removeItem('omok_room');
    }
    state.mode = null;
    state.online = { code: null, token: null, myColor: null, connected: false };
    hideModal();
    $('#waitingBox').classList.add('hidden');
    showScreen('screen-home');
  }

  /* ---------------- 기보 / 채팅 탭 ---------------- */
  $$('.panel-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.panel-tabs .tab').forEach((t) => t.classList.remove('active'));
      $$('.tab-pane').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $('#pane-' + tab.dataset.tab).classList.add('active');
    });
  });
  $('#btnLog').addEventListener('click', () => {
    $$('.panel-tabs .tab')[0].click();
    $('#sidePanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('#btnChat').addEventListener('click', () => {
    $$('.panel-tabs .tab')[1].click();
    $('#sidePanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  function sendChat(text) {
    if (!text || state.mode !== 'online') return;
    socket.emit('chat:message', { text });
    $('#chatText').value = '';
  }
  $('#chatSend').addEventListener('click', () => sendChat($('#chatText').value.trim()));
  $('#chatText').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat($('#chatText').value.trim()); });

  function addChatMessage(name, text, mine, isEmote) {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = `<b>${mine ? '나' : name}</b> ${isEmote ? '' : ':'} ${text}`;
    $('#chatList').appendChild(div);
    $('#chatList').scrollTop = $('#chatList').scrollHeight;
  }

  /* ---------------- 이모티콘 ---------------- */
  $('#btnEmote').addEventListener('click', () => {
    const bar = $('#emoteBar');
    if (bar.classList.contains('hidden')) {
      bar.innerHTML = '';
      EMOTES.forEach((em) => {
        const b = document.createElement('button');
        b.textContent = em;
        b.onclick = () => {
          flyEmote(em);
          if (state.mode === 'online') socket.emit('chat:emote', { emoji: em });
          bar.classList.add('hidden');
        };
        bar.appendChild(b);
      });
      bar.classList.remove('hidden');
    } else {
      bar.classList.add('hidden');
    }
  });
  function flyEmote(emoji) {
    const layer = $('#emoteLayer');
    const s = document.createElement('div');
    s.className = 'emote-fly';
    s.textContent = emoji;
    layer.appendChild(s);
    setTimeout(() => s.remove(), 1450);
  }

  /* ---------------- 복기 ---------------- */
  $('#btnReview').addEventListener('click', () => {
    state.reviewing = true;
    state.reviewIndex = state.moves.length;
    $('#reviewBar').classList.remove('hidden');
    renderReview();
  });
  $('#rvExit').addEventListener('click', () => {
    state.reviewing = false;
    $('#reviewBar').classList.add('hidden');
    renderBoard();
  });
  $('#rvFirst').addEventListener('click', () => { state.reviewIndex = 0; renderReview(); });
  $('#rvPrev').addEventListener('click', () => { state.reviewIndex = Math.max(0, state.reviewIndex - 1); renderReview(); });
  $('#rvNext').addEventListener('click', () => { state.reviewIndex = Math.min(state.moves.length, state.reviewIndex + 1); renderReview(); });
  $('#rvLast').addEventListener('click', () => { state.reviewIndex = state.moves.length; renderReview(); });

  function renderReview() {
    const idx = state.reviewIndex;
    const board = R.createBoard(SIZE);
    for (let i = 0; i < idx; i++) {
      const m = state.moves[i];
      board[m.y][m.x] = m.color;
    }
    const layer = $('#stones');
    layer.innerHTML = '';
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const c = board[y][x];
        if (!c) continue;
        const { dx, dy } = toDisplay(x, y);
        const s = document.createElement('div');
        s.className = 'stone ' + c;
        if (idx > 0 && state.moves[idx - 1].x === x && state.moves[idx - 1].y === y) s.classList.add('last-move');
        s.style.left = pct(dx); s.style.top = pct(dy);
        layer.appendChild(s);
      }
    }
    $('#rvCount').textContent = `${idx} / ${state.moves.length}`;
    if (idx === 0) {
      $('#rvMove').textContent = '시작 위치예요';
    } else {
      const m = state.moves[idx - 1];
      $('#rvMove').textContent = `${colorStone(m.color)} ${COLS[m.x]}${SIZE - m.y}`;
    }
    $$('#moveLog li').forEach((li) => li.classList.toggle('cur', Number(li.dataset.idx) === idx - 1));
  }

  /* ---------------- 초기화 ---------------- */
  function buildLearnList() {
    const items = [
      { ico: '⚫', t: '흑돌이 먼저', s: '검은 돌을 가진 사람이 첫 수를 둬요' },
      { ico: '↔️', t: '가로 다섯 줄', s: '가로로 같은 색 돌 5개를 연결하면 승리' },
      { ico: '↕️', t: '세로 다섯 줄', s: '세로로 같은 색 돌 5개를 연결해도 승리' },
      { ico: '↗️', t: '대각선 다섯 줄', s: '대각선 방향으로 5개를 연결해도 승리' },
      { ico: '💡', t: '막기도 중요해요', s: '상대가 4개를 이었다면 반드시 막아야 해요' },
    ];
    const wrap = $('#learnList');
    wrap.innerHTML = '';
    items.forEach((it) => {
      const div = document.createElement('div');
      div.className = 'learn-item';
      div.innerHTML = `<span class="li-ico">${it.ico}</span><span class="li-text"><b>${it.t}</b><span>${it.s}</span></span>`;
      wrap.appendChild(div);
    });
  }

  function init() {
    loadProfile();
    buildLearnList();
    initBoardDOM();

    // 게임 도중 새로고침 대비: 저장된 방 정보가 있으면 재접속 시도
    try {
      const saved = JSON.parse(sessionStorage.getItem('omok_room') || 'null');
      if (saved && saved.code && saved.token) {
        ensureSocket();
        socket.emit('room:rejoin', saved, (res) => {
          if (!res || !res.ok) { sessionStorage.removeItem('omok_room'); return; }
          state.online.code = res.code;
          state.online.token = res.token;
          state.online.myColor = res.color;
          state.mySide = res.color;
          state.board = res.board;
          state.turn = res.turn;
          state.status = res.status;
          state.winner = res.winner;
          state.winLine = res.winLine;
          state.moves = [];
          const meP = res.players.find((p) => p.token === res.token);
          const oppP = res.players.find((p) => p.token !== res.token);
          state.players.black = res.color === R.BLACK ? profileOf(meP) : profileOf(oppP);
          state.players.white = res.color === R.WHITE ? profileOf(meP) : profileOf(oppP);
          startGame('online', true);
        });
      }
    } catch (e) { /* 무시 */ }
  }

  init();
})();
