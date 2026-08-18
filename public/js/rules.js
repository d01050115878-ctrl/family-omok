/* =========================================================
   오목 규칙 엔진 (브라우저 & Node 양쪽에서 사용)
   ========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OmokRules = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const SIZE = 19; // 19 x 19 확장 오목판 (교차점 기준) — 승부가 오래 갈 수 있도록 표준 바둑판 크기로 확장
  const BLACK = 'black';
  const WHITE = 'white';
  const MAX_UNDOS = 3; // 한 판에서 각 플레이어가 쓸 수 있는 무르기 횟수

  const DIRS = [
    [1, 0],   // 가로
    [0, 1],   // 세로
    [1, 1],   // 대각선 \
    [1, -1],  // 대각선 /
  ];

  function createBoard(size) {
    size = size || SIZE;
    const b = new Array(size);
    for (let y = 0; y < size; y++) b[y] = new Array(size).fill(null);
    return b;
  }

  function cloneBoard(board) {
    return board.map((row) => row.slice());
  }

  function inBounds(x, y, size) {
    size = size || SIZE;
    return x >= 0 && x < size && y >= 0 && y < size;
  }

  function other(player) {
    return player === BLACK ? WHITE : BLACK;
  }

  // (x,y)에 player 돌을 두었다고 가정했을 때 승리 여부와 승리 라인을 반환
  function checkWin(board, x, y, player, size) {
    size = size || board.length;
    for (const [dx, dy] of DIRS) {
      const line = [[x, y]];
      // 정방향
      let cx = x + dx, cy = y + dy;
      while (inBounds(cx, cy, size) && board[cy][cx] === player) {
        line.push([cx, cy]);
        cx += dx; cy += dy;
      }
      // 역방향
      cx = x - dx; cy = y - dy;
      while (inBounds(cx, cy, size) && board[cy][cx] === player) {
        line.unshift([cx, cy]);
        cx -= dx; cy -= dy;
      }
      if (line.length >= 5) {
        // 자유룰: 5개 이상 나란히 있으면 승리 (장목 인정)
        return { win: true, line: line.slice(0, Math.max(5, line.length)) };
      }
    }
    return { win: false, line: null };
  }

  function isBoardFull(board) {
    for (let y = 0; y < board.length; y++) {
      for (let x = 0; x < board[y].length; x++) {
        if (!board[y][x]) return false;
      }
    }
    return true;
  }

  function isValidMove(board, x, y, size) {
    size = size || board.length;
    return inBounds(x, y, size) && !board[y][x];
  }

  // 특정 지점 (x,y)에서 dx,dy 방향으로 player 기준 연속 개수와 열린 끝 개수 계산
  // (place 는 하지 않은 상태에서, player가 그 자리에 둔다고 가정)
  function lineInfo(board, x, y, dx, dy, player, size) {
    size = size || board.length;
    let count = 1;
    let openEnds = 0;

    let cx = x + dx, cy = y + dy;
    while (inBounds(cx, cy, size) && board[cy][cx] === player) {
      count++; cx += dx; cy += dy;
    }
    if (inBounds(cx, cy, size) && board[cy][cx] === null) openEnds++;

    cx = x - dx; cy = y - dy;
    while (inBounds(cx, cy, size) && board[cy][cx] === player) {
      count++; cx -= dx; cy -= dy;
    }
    if (inBounds(cx, cy, size) && board[cy][cx] === null) openEnds++;

    return { count, openEnds };
  }

  function getCenter(size) {
    size = size || SIZE;
    return Math.floor(size / 2);
  }

  // (x,y)에 player가 두었다고 가정할 때 만들어지는 "열린 3"(양쪽이 뚫린 3목)의 개수
  function countOpenThrees(board, x, y, player, size) {
    size = size || board.length;
    let n = 0;
    for (const [dx, dy] of DIRS) {
      const { count, openEnds } = lineInfo(board, x, y, dx, dy, player, size);
      if (count === 3 && openEnds === 2) n++;
    }
    return n;
  }

  // 삼삼(3-3) 금수 판정: 흑이 한 수로 열린 3을 두 개 이상 동시에 만들면 둘 수 없다.
  // (렌주룰과 동일하게 흑에게만 적용하며, 그 수로 바로 이기는 경우는 예외로 허용한다)
  function isForbiddenMove(board, x, y, player, size) {
    size = size || board.length;
    if (player !== BLACK) return false;
    if (checkWin(board, x, y, player, size).win) return false;
    return countOpenThrees(board, x, y, player, size) >= 2;
  }

  return {
    SIZE, BLACK, WHITE, DIRS, MAX_UNDOS,
    createBoard, cloneBoard, inBounds, other,
    checkWin, isBoardFull, isValidMove, lineInfo, getCenter,
    countOpenThrees, isForbiddenMove,
  };
});
