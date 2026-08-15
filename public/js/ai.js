/* =========================================================
   오목 AI 엔진 (휴리스틱 평가 + 미니맥스 탐색)
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

  // player가 지금 당장(현재 보드 그대로) 둘 수 있는, 즉시 5목이 완성되는 자리들
  // (돌 근처 후보만 확인하면 충분 — 승리 라인은 항상 기존 돌들 곁에 생긴다)
  function findImmediateWins(board, player, size) {
    size = size || board.length;
    const wins = [];
    for (const c of getCandidates(board, size)) {
      if (Rules.checkWin(board, c.x, c.y, player, size).win) wins.push(c);
    }
    return wins;
  }

  // (x,y)에 player가 두었을 때, 상대에게 "즉시 이길 수 있는 자리"가 2개 이상 생기는지 확인.
  // (그렇다면 다음 상대 차례에 어느 쪽이든 막을 수 없는 필패 상황이므로 반드시 피해야 한다)
  function createsOpponentDoubleWin(board, x, y, player, size) {
    size = size || board.length;
    const opp = Rules.other(player);
    const b2 = Rules.cloneBoard(board);
    b2[y][x] = player;
    return findImmediateWins(b2, opp, size).length >= 2;
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

  // player 시점에서 반드시 처리해야 할 상황(즉시 승리 / 상대 즉시 승리 저지)이 있는지 확인.
  // 있다면 그 수를 강제로 반환하고, 없다면 null.
  // 난이도(레벨)와 무관하게 항상 적용해서 "뻔한 3목/4목을 놓친다" 같은 실수를 없앤다.
  function forcedMove(board, player, size) {
    size = size || board.length;
    const opp = Rules.other(player);

    const myWins = findImmediateWins(board, player, size)
      .filter((c) => !Rules.isForbiddenMove(board, c.x, c.y, player, size));
    if (myWins.length) return myWins[0];

    const oppWins = findImmediateWins(board, opp, size);
    if (oppWins.length === 1) {
      if (!Rules.isForbiddenMove(board, oppWins[0].x, oppWins[0].y, player, size)) {
        return oppWins[0];
      }
    } else if (oppWins.length >= 2) {
      // 이미 필패 상황(막을 수 없는 더블 승리) — 그나마 가장 나은 수를 시도
      return null;
    }
    return null;
  }

  // 미니맥스(네가맥스 + 알파-베타 가지치기): depth번의 내 수-상대 수 교환까지 내다본다.
  function negamax(board, player, size, depth, topN, alpha, beta) {
    const forced = forcedMove(board, player, size);
    if (forced) {
      const score = Rules.checkWin(board, forced.x, forced.y, player, size).win ? SCORE.FIVE : SCORE.FOUR;
      return { score, move: forced };
    }

    const ranked = rankMoves(board, player, size);
    if (!ranked.length) return { score: 0, move: null };
    if (ranked[0].score >= SCORE.FIVE) return { score: SCORE.FIVE, move: ranked[0] };
    if (depth <= 0) return { score: ranked[0].score, move: ranked[0] };

    const opp = Rules.other(player);
    let bestMove = ranked[0];
    let bestScore = -Infinity;
    for (const cand of ranked.slice(0, topN)) {
      const b2 = Rules.cloneBoard(board);
      b2[cand.y][cand.x] = player;
      let score;
      if (Rules.checkWin(b2, cand.x, cand.y, player, size).win) {
        score = SCORE.FIVE;
      } else {
        const sub = negamax(b2, opp, size, depth - 1, topN, -beta, -alpha);
        score = cand.score - sub.score * 0.98;
      }
      if (score > bestScore) { bestScore = score; bestMove = cand; }
      if (bestScore > alpha) alpha = bestScore;
      if (alpha >= beta) break;
    }
    return { score: bestScore, move: bestMove };
  }

  function bestByLookahead(board, player, size, topN, depth) {
    const { move } = negamax(board, player, size, depth || 1, topN, -Infinity, Infinity);
    return move;
  }

  /**
   * level: 1(초보) ~ 5(고수)
   */
  function getMove(board, player, level, size) {
    size = size || board.length;

    // 승리 수 / 상대의 즉시 승리 저지는 난이도와 상관없이 항상 정확하게 처리한다.
    const forced = forcedMove(board, player, size);
    if (forced) return { x: forced.x, y: forced.y };

    const ranked = rankMoves(board, player, size);
    if (!ranked.length) return null;

    // 열린 3 이상의 실전 위협(공격/수비)이 걸린 급박한 상황이면
    // 난이도와 무관하게 항상 내다보기를 통해 최선의 수를 둔다.
    const critical = ranked[0].score >= SCORE.OPEN_THREE;
    if (critical) {
      const topN = level >= 5 ? 14 : level >= 4 ? 11 : level >= 3 ? 9 : 6;
      const depth = level >= 5 ? 4 : level >= 4 ? 4 : level >= 3 ? 3 : 2;
      const m = bestByLookahead(board, player, size, topN, depth);
      return { x: m.x, y: m.y };
    }

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
        const m = bestByLookahead(board, player, size, 9, 3);
        return { x: m.x, y: m.y };
      }
      case 4: {
        const m = bestByLookahead(board, player, size, 11, 4);
        return { x: m.x, y: m.y };
      }
      case 5:
      default: {
        const m = bestByLookahead(board, player, size, 14, 4);
        return { x: m.x, y: m.y };
      }
    }
  }

  // 힌트용: 항상 최선 수 (표시용이므로 내다보기 포함)
  function getHint(board, player, size) {
    const forced = forcedMove(board, player, size);
    if (forced) return { x: forced.x, y: forced.y };
    const m = bestByLookahead(board, player, size, 10, 2);
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
