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

  const SIZE = 15; // 15 x 15 표준 오목판 (교차점 기준)
  const BLACK = 'black';
  const WHITE = 'white';

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

  return {
    SIZE, BLACK, WHITE, DIRS,
    createBoard, cloneBoard, inBounds, other,
    checkWin, isBoardFull, isValidMove, lineInfo, getCenter,
  };
});
