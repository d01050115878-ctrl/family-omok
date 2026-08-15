/* =========================================================
   오목 AI 엔진 (휴리스틱 평가 + 얕은 탐색)
   ========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./rules.js'));
  } else {
    root.OmokAI = factory(root.OmokRules);
  }
})(typeof self !== 'undefined' ? self : this, function (Rules) {

  const SCORE = {
    FIVE: 100000000,
    OPEN_FOUR: 5000000,
    FOUR: 500000,
    OPEN_THREE: 50000,
    THREE: 3000,
    OPEN_TWO: 500,
    TWO: 100,
    ONE: 10,
  };

  function patternScore(count, openEnds) {
    if (count >= 5) return SCORE.FIVE;
    if (count === 4) return openEnds >= 1 ? (openEnds === 2 ? SCORE.OPEN_FOUR : SCORE.FOUR) : 0;
    if (count === 3) return openEnds >= 1 ? (openEnds === 2 ? SCORE.OPEN_THREE : SCORE.THREE) : 0;
    if (count === 2) return openEnds >= 1 ? (openEnds === 2 ? SCORE.OPEN_TWO : SCORE.TWO) : 0;
    if (count === 1) return openEnds >= 1 ? SCORE.ONE : 0;
    return 0;
  }

  // (x,y)에 player가 두었다고 가정할 때의 공격력 점수
  function pointOffenseScore(board, x, y, player, size) {
    let total = 0;
    for (const [dx, dy] of Rules.DIRS) {
      const { count, openEnds } = Rules.lineInfo(board, x, y, dx, dy, player, size);
      total += patternScore(count, openEnds);
    }
    return total;
  }

  // 후보 지점: 이미 놓인 돌 주변 2칸 이내 (돌이 하나도 없으면 중앙)
  function getCandidates(board, size) {
    size = size || board.length;
    const set = new Set();
    let any = false;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!board[y][x]) continue;
        any = true;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx, ny = y + dy;
            if (Rules.inBounds(nx, ny, size) && !board[ny][nx]) {
              set.add(ny * size + nx);
            }
          }
        }
      }
    }
    if (!any) {
      const c = Rules.getCenter(size);
      return [{ x: c, y: c }];
    }
    return Array.from(set).map((v) => ({ x: v % size, y: Math.floor(v / size) }));
  }

  // 특정 player 관점에서 (x,y)의 종합 점수 (공격 + 수비)
  function evaluatePoint(board, x, y, player, size) {
    const opp = Rules.other(player);
    const off = pointOffenseScore(board, x, y, player, size);
    const def = pointOffenseScore(board, x, y, opp, size);
    // 상대의 승리를 막는 것은 거의 동급으로 중요하게, 약간 낮은 가중치
    return off + def * 0.92;
  }

  // (x,y)에 player가 두었을 때, 상대에게 "즉시 이길 수 있는 자리"가 2개 이상 생기는지 확인.
  // (그렇다면 다음 상대 차례에 어느 쪽이든 막을 수 없는 필패 상황이므로 반드시 피해야 한다)
  function createsOpponentDoubleWin(board, x, y, player, size) {
    size = size || board.length;
    const opp = Rules.other(player);
    const b2 = Rules.cloneBoard(board);
    b2[y][x] = player;
    let wins = 0;
    for (let yy = 0; yy < size; yy++) {
      for (let xx = 0; xx < size; xx++) {
        if (b2[yy][xx]) continue;
        if (Rules.checkWin(b2, xx, yy, opp, size).win) {
          wins++;
          if (wins >= 2) return true;
        }
      }
    }
    return false;
  }

  function rankMoves(board, player, size) {
    size = size || board.length;
    const candidates = getCandidates(board, size)
      .filter((c) => !Rules.isForbiddenMove(board, c.x, c.y, player, size));
    const ranked = candidates.map((c) => {
      let score = evaluatePoint(board, c.x, c.y, player, size);
      // 이 수 자체가 승리가 아니면서, 상대에게 막을 수 없는 더블 승리 기회를 열어준다면 최악으로 취급
      if (score < SCORE.FIVE && createsOpponentDoubleWin(board, c.x, c.y, player, size)) {
        score -= SCORE.FIVE;
      }
      return { x: c.x, y: c.y, score };
    });
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }

  function pickWeightedRandom(list, count) {
    const pool = list.slice(0, Math.min(count, list.length));
    const minScore = Math.min(0, ...pool.map((m) => m.score));
    const total = pool.reduce((s, m) => s + (m.score - minScore + 1), 0);
    let r = Math.random() * total;
    for (const m of pool) {
      r -= (m.score - minScore + 1);
      if (r <= 0) return m;
    }
    return pool[0];
  }

  // 2-수 내다보기: AI가 후보에 두었을 때, 상대의 최선 응수 점수를 최소화하는 수 선택
  function bestByLookahead(board, player, size, topN) {
    const ranked = rankMoves(board, player, size);
    const top = ranked.slice(0, topN);
    const opp = Rules.other(player);
    let best = null;
    for (const move of top) {
      // 즉시 승리라면 바로 선택
      if (move.score >= SCORE.FIVE) return move;

      const b2 = Rules.cloneBoard(board);
      b2[move.y][move.x] = player;
      const win = Rules.checkWin(b2, move.x, move.y, player, size);
      if (win.win) return move;

      const oppRanked = rankMoves(b2, opp, size);
      const oppBest = oppRanked.length ? oppRanked[0].score : 0;
      const combined = move.score - oppBest * 0.98;
      if (!best || combined > best.combined) {
        best = { ...move, combined };
      }
    }
    return best || ranked[0];
  }

  /**
   * level: 1(초보) ~ 5(고수)
   */
  function getMove(board, player, level, size) {
    size = size || board.length;
    const ranked = rankMoves(board, player, size);
    if (!ranked.length) return null;

    // 즉시 승리 수가 있으면 난이도 무관하게 항상 선택 (너무 허무하게 지지 않도록)
    if (ranked[0].score >= SCORE.FIVE) return { x: ranked[0].x, y: ranked[0].y };

    switch (level) {
      case 1: {
        // 30% 확률로 상위 절반 안에서 완전 무작위, 아니면 상위 50% 중 가중 무작위
        if (Math.random() < 0.3) {
          const half = ranked.slice(0, Math.max(4, Math.ceil(ranked.length * 0.5)));
          const r = half[Math.floor(Math.random() * half.length)];
          return { x: r.x, y: r.y };
        }
        const m = pickWeightedRandom(ranked, Math.max(4, Math.ceil(ranked.length * 0.5)));
        return { x: m.x, y: m.y };
      }
      case 2: {
        const m = pickWeightedRandom(ranked, 5);
        return { x: m.x, y: m.y };
      }
      case 3: {
        if (Math.random() < 0.15) {
          const m = pickWeightedRandom(ranked, 3);
          return { x: m.x, y: m.y };
        }
        const m = bestByLookahead(board, player, size, 6);
        return { x: m.x, y: m.y };
      }
      case 4: {
        const m = bestByLookahead(board, player, size, 9);
        return { x: m.x, y: m.y };
      }
      case 5:
      default: {
        const m = bestByLookahead(board, player, size, 22);
        return { x: m.x, y: m.y };
      }
    }
  }

  // 힌트용: 항상 최선 수 (표시용이므로 살짝 내다보기 포함)
  function getHint(board, player, size) {
    const m = bestByLookahead(board, player, size, 10);
    return m ? { x: m.x, y: m.y } : null;
  }

  // 코치용: 방금 둔 수가 그 순간 최선 대비 얼마나 좋았는지 평가
  function evaluateMoveQuality(board, x, y, player, size) {
    const ranked = rankMoves(board, player, size);
    if (!ranked.length) return { quality: 'ok', bestScore: 0, playedScore: 0 };
    const bestScore = ranked[0].score;
    const played = ranked.find((m) => m.x === x && m.y === y);
    const playedScore = played ? played.score : evaluatePoint(board, x, y, player, size);
    let quality = 'ok';
    if (playedScore >= bestScore * 0.98) quality = 'great';
    else if (playedScore >= bestScore * 0.7) quality = 'good';
    else if (playedScore <= bestScore * 0.15) quality = 'bad';
    return { quality, bestScore, playedScore };
  }

  return { getMove, getHint, evaluateMoveQuality, rankMoves, evaluatePoint, SCORE };
});
