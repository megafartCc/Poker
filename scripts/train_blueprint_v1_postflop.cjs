const fs = require("fs");
const path = require("path");
const PokerEvaluator = require("poker-evaluator");
const {
  A,
  actionNames,
  legalActions: legalActionsShared,
  actionTarget: actionTargetShared,
} = require("../lib/action_model.cjs");
const { texture, buildInfosetKey } = require("../lib/infoset_v1.cjs");

const OUT_PATH = process.env.OUT_PATH || process.argv[2] || path.join(__dirname, "..", "data", "postflop_blueprint_v1.json");
const TARGET_ITERS = Number(process.env.ITERS || process.argv[3] || 10000000);
const SEED = Number(process.env.SEED || process.argv[4] || 1337);
const EQUITY_TRIALS_TRAIN = clamp(Number(process.env.EQUITY_TRIALS_TRAIN || process.argv[5] || 180), 100, 300);
const CHECKPOINT_EVERY = Number(process.env.CHECKPOINT_EVERY || 500000);
const EVAL_HANDS_PER_PROFILE = Number(process.env.EVAL_HANDS_PER_PROFILE || 2000);
const EQUITY_TRIALS_EVAL = clamp(Number(process.env.EQUITY_TRIALS_EVAL || 600), 100, 2000);
const MIN_ITERS_BEFORE_STOP = Number(process.env.MIN_ITERS_BEFORE_STOP || 1500000);
const DRIFT_PLATEAU_THRESHOLD = Number(process.env.DRIFT_PLATEAU_THRESHOLD || 0.015);
const EV_PLATEAU_THRESHOLD = Number(process.env.EV_PLATEAU_THRESHOLD || 0.02);
const WRITE_POLICY_EACH_CHECKPOINT = String(process.env.WRITE_POLICY_EACH_CHECKPOINT || "1") !== "0";

const START_STACK = Number(process.env.START_STACK || 200);
const SMALL_BLIND = Number(process.env.SMALL_BLIND || 1);
const BIG_BLIND = Number(process.env.BIG_BLIND || 2);
const MAX_RAISES = Number(process.env.MAX_RAISES || 3);

const profiles = ["nit", "station", "aggro", "pot_odds"];
const streets = ["preflop", "flop", "turn", "river"];
const ranks = "23456789TJQKA";
const suits = "shdc";

function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function makeRng(initial) {
  let s = (initial >>> 0) || 1;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randInt(rand, n) {
  return Math.floor(rand() * n);
}

function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rand, i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
}

function rankValue(card) {
  return ranks.indexOf(card[0]) + 2;
}

function sampleActionByWeights(legal, weights, rand) {
  let sum = 0;
  for (const a of legal) sum += Math.max(0, Number(weights[a] || 0));
  if (sum <= 1e-12) return legal[randInt(rand, legal.length)];
  let r = rand() * sum;
  for (const a of legal) {
    r -= Math.max(0, Number(weights[a] || 0));
    if (r <= 0) return a;
  }
  return legal[legal.length - 1];
}

function sampleDeck(rand) {
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push(`${r}${s}`);
  shuffleInPlace(deck, rand);
  return deck;
}

function legalActions(state) {
  return legalActionsShared(state, MAX_RAISES, BIG_BLIND);
}

function actionTarget(state, act) {
  return actionTargetShared(state, act, BIG_BLIND);
}

function applyAction(state, act) {
  const p = state.toAct;
  const o = 1 - p;
  const toCall = Math.max(0, state.currentBet - state.commit[p]);
  if (act === A.CALL && toCall <= 1e-9) act = A.CHECK;
  if (act === A.FOLD) {
    state.terminal = true;
    state.winner = o;
    state.history += "f";
    state.acted[p] = true;
    return;
  }
  if (act === A.CHECK) {
    state.history += "k";
    state.toAct = o;
    state.acted[p] = true;
    return;
  }
  const target = actionTarget(state, act);
  const pay = Math.max(0, target - state.commit[p]);
  const realPay = Math.min(pay, state.stack[p]);
  state.stack[p] -= realPay;
  state.commit[p] += realPay;
  state.pot += realPay;
  state.history += "x";
  if (act === A.CALL || act === A.ALL_IN) {
    state.acted[p] = true;
    if (state.commit[p] > state.currentBet) {
      state.currentBet = state.commit[p];
      state.raises += 1;
      state.acted = [false, false];
      state.acted[p] = true;
    }
    state.toAct = o;
    return;
  }
  state.currentBet = state.commit[p];
  state.raises += 1;
  state.acted = [false, false];
  state.acted[p] = true;
  state.toAct = o;
}

function needsStreetAdvance(state) {
  const eps = 1e-9;
  const evenCommit = Math.abs(state.commit[0] - state.commit[1]) <= eps
    && Math.max(state.currentBet - state.commit[state.toAct], 0) <= eps;
  return evenCommit && state.acted[0] && state.acted[1];
}

function bettingClosedAllIn(state) {
  const s0AllIn = state.stack[0] <= 1e-9;
  const s1AllIn = state.stack[1] <= 1e-9;
  if (!(s0AllIn || s1AllIn)) return false;
  const toCall0 = Math.max(0, state.currentBet - state.commit[0]);
  const toCall1 = Math.max(0, state.currentBet - state.commit[1]);
  return toCall0 <= 1e-9 && toCall1 <= 1e-9;
}

function advanceStreet(state, fullBoard) {
  state.streetIdx += 1;
  state.street = streets[state.streetIdx];
  if (state.streetIdx === 1) state.board = fullBoard.slice(0, 3);
  else if (state.streetIdx === 2) state.board = fullBoard.slice(0, 4);
  else if (state.streetIdx === 3) state.board = fullBoard.slice(0, 5);
  state.currentBet = 0;
  state.commit = [0, 0];
  state.raises = 0;
  state.acted = [false, false];
  state.toAct = 0;
}

function maybeProgressState(state, fullBoard) {
  while (!state.terminal) {
    if (bettingClosedAllIn(state)) {
      while (!state.terminal && state.streetIdx < 3) advanceStreet(state, fullBoard);
      if (state.streetIdx === 3) {
        state.terminal = true;
        state.winner = -1;
      }
      break;
    }
    if (needsStreetAdvance(state)) {
      if (state.streetIdx < 3) {
        advanceStreet(state, fullBoard);
        continue;
      }
      state.terminal = true;
      state.winner = -1;
      break;
    }
    break;
  }
}

function cloneState(state) {
  return {
    streetIdx: state.streetIdx,
    street: state.street,
    pot: state.pot,
    currentBet: state.currentBet,
    commit: [state.commit[0], state.commit[1]],
    stack: [state.stack[0], state.stack[1]],
    raises: state.raises,
    acted: [state.acted[0], state.acted[1]],
    history: state.history,
    terminal: state.terminal,
    winner: state.winner,
    toAct: state.toAct,
    board: state.board.slice(),
  };
}

function canonicalCards(cards) {
  return cards.slice().sort().join(",");
}

function evalStrengthRandomRange(heroHand, board, trials, rand, cache) {
  if (heroHand.length !== 2) return 0.5;
  const key = `${canonicalCards(heroHand)}|${canonicalCards(board)}|t=${trials}`;
  if (cache.has(key)) return cache.get(key);

  const used = new Set([...heroHand, ...board]);
  const avail = [];
  for (const s of suits) {
    for (const r of ranks) {
      const card = `${r}${s}`;
      if (!used.has(card)) avail.push(card);
    }
  }

  let wins = 0;
  let ties = 0;
  let total = 0;
  for (let t = 0; t < trials; t++) {
    const pool = avail.slice();
    shuffleInPlace(pool, rand);
    const opp = [pool.pop(), pool.pop()];
    const boardFill = board.slice();
    while (boardFill.length < 5) boardFill.push(pool.pop());
    const h = PokerEvaluator.evalHand([...heroHand, ...boardFill]);
    const o = PokerEvaluator.evalHand([...opp, ...boardFill]);
    if (h.value > o.value) wins += 1;
    else if (h.value === o.value) ties += 1;
    total += 1;
  }

  const hs = total > 0 ? (wins + 0.5 * ties) / total : 0.5;
  cache.set(key, hs);
  return hs;
}

function preflopTier(hand) {
  const r1 = rankValue(hand[0]);
  const r2 = rankValue(hand[1]);
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  const pair = r1 === r2;
  const suited = hand[0][1] === hand[1][1];
  const gap = hi - lo;
  if (pair) {
    if (hi >= 12) return "premium";
    if (hi >= 9) return "strong";
    if (hi >= 6) return "medium";
    return "speculative";
  }
  if (suited && hi === 14 && lo >= 10) return "premium";
  if (hi === 14 && lo >= 12) return "strong";
  if (suited && hi >= 13 && lo >= 10) return "strong";
  if (hi >= 13 && lo >= 11) return "medium";
  if (suited && gap <= 2 && hi >= 9) return "medium";
  if (suited && hi === 14) return "medium";
  if (gap <= 1 && hi >= 10) return "speculative";
  if (suited && hi >= 9) return "speculative";
  return "trash";
}

function preflopHsByTier(tier) {
  if (tier === "premium") return 0.67;
  if (tier === "strong") return 0.58;
  if (tier === "medium") return 0.50;
  if (tier === "speculative") return 0.43;
  return 0.34;
}

function normalizeWeights(weights, legal) {
  let sum = 0;
  for (const a of legal) sum += Math.max(0, weights[a] || 0);
  if (sum <= 1e-12) {
    const u = 1 / Math.max(1, legal.length);
    for (const a of legal) weights[a] = u;
    return weights;
  }
  for (const a of legal) weights[a] = Math.max(0, weights[a] || 0) / sum;
  return weights;
}

function buildPreflopMix(hand, legal, hs, toCall, raises) {
  const tier = preflopTier(hand);
  let raise = 0;
  let call = 0;
  let passive = 0;
  const facingRaise = toCall > 1e-9 && raises >= 1;
  if (!facingRaise) {
    if (tier === "premium") { raise = 0.95; call = 0.05; }
    else if (tier === "strong") { raise = 0.85; call = 0.13; passive = 0.02; }
    else if (tier === "medium") { raise = 0.62; call = 0.30; passive = 0.08; }
    else if (tier === "speculative") { raise = 0.36; call = 0.42; passive = 0.22; }
    else { raise = 0.14; call = 0.32; passive = 0.54; }
  } else {
    if (tier === "premium") { raise = 0.70; call = 0.25; passive = 0.05; }
    else if (tier === "strong") { raise = 0.35; call = 0.50; passive = 0.15; }
    else if (tier === "medium") { raise = 0.12; call = 0.43; passive = 0.45; }
    else if (tier === "speculative") { raise = 0.06; call = 0.30; passive = 0.64; }
    else { raise = 0.02; call = 0.18; passive = 0.80; }
  }
  if (hs < 0.42) {
    raise = Math.max(0, raise - 0.10);
    passive = Math.min(1, passive + 0.10);
  } else if (hs > 0.62) {
    raise = Math.min(1, raise + 0.08);
    passive = Math.max(0, passive - 0.06);
  }
  const w = Array(actionNames.length).fill(0);
  if (legal.includes(A.RAISE_HALF)) w[A.RAISE_HALF] = raise * (legal.includes(A.RAISE_POT) ? 0.85 : 1);
  if (legal.includes(A.RAISE_POT)) w[A.RAISE_POT] = raise * (legal.includes(A.RAISE_HALF) ? 0.15 : 1);
  if (legal.includes(A.CALL)) w[A.CALL] = call;
  if (legal.includes(A.CHECK)) w[A.CHECK] = passive;
  if (legal.includes(A.FOLD) && !legal.includes(A.CHECK)) w[A.FOLD] = passive;
  if (legal.includes(A.ALL_IN)) w[A.ALL_IN] = hs > 0.80 ? 0.06 : 0;
  return normalizeWeights(w, legal);
}

function createHandContext(rand) {
  const deck = sampleDeck(rand);
  const hands = [
    [deck.pop(), deck.pop()],
    [deck.pop(), deck.pop()],
  ];
  const fullBoard = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
  const state = {
    streetIdx: 0,
    street: "preflop",
    pot: SMALL_BLIND + BIG_BLIND,
    currentBet: BIG_BLIND,
    commit: [SMALL_BLIND, BIG_BLIND],
    stack: [START_STACK - SMALL_BLIND, START_STACK - BIG_BLIND],
    raises: 0,
    acted: [false, false],
    history: "",
    terminal: false,
    winner: -1,
    toAct: 0,
    board: [],
  };
  return { hands, fullBoard, state };
}

function runPreflopToPostflop(ctx, rand) {
  const equityCache = new Map();
  while (!ctx.state.terminal && ctx.state.streetIdx === 0) {
    maybeProgressState(ctx.state, ctx.fullBoard);
    if (ctx.state.terminal || ctx.state.streetIdx > 0) break;
    const p = ctx.state.toAct;
    const legal = legalActions(ctx.state);
    if (!legal.length) {
      ctx.state.terminal = true;
      ctx.state.winner = 1 - p;
      break;
    }
    const tier = preflopTier(ctx.hands[p]);
    const hs = preflopHsByTier(tier);
    const toCall = Math.max(0, ctx.state.currentBet - ctx.state.commit[p]);
    const mix = buildPreflopMix(ctx.hands[p], legal, hs, toCall, ctx.state.raises);
    const action = sampleActionByWeights(legal, mix, rand);
    applyAction(ctx.state, action);
    if (equityCache.size > 4096) equityCache.clear();
  }
  maybeProgressState(ctx.state, ctx.fullBoard);
}

function resolveWinner(ctx, state) {
  if (state.winner === 0 || state.winner === 1) return state.winner;
  const board = ctx.fullBoard.slice(0, 5);
  const h0 = PokerEvaluator.evalHand([...ctx.hands[0], ...board]);
  const h1 = PokerEvaluator.evalHand([...ctx.hands[1], ...board]);
  if (h0.value > h1.value) return 0;
  if (h1.value > h0.value) return 1;
  return -1;
}

function terminalUtility(ctx, state, traverser) {
  const stacks = [state.stack[0], state.stack[1]];
  const winner = resolveWinner(ctx, state);
  if (winner === 0 || winner === 1) {
    stacks[winner] += state.pot;
  } else {
    stacks[0] += state.pot * 0.5;
    stacks[1] += state.pot * 0.5;
  }
  return (stacks[traverser] - START_STACK) / BIG_BLIND;
}

function ensureNode(nodeMap, key) {
  let node = nodeMap.get(key);
  if (!node) {
    node = {
      regrets: Array(actionNames.length).fill(0),
      strategySum: Array(actionNames.length).fill(0),
      legalSeen: Array(actionNames.length).fill(false),
      visits: 0,
    };
    nodeMap.set(key, node);
  }
  return node;
}

function currentStrategy(node, legal) {
  const strat = Array(actionNames.length).fill(0);
  let sum = 0;
  for (const a of legal) {
    const v = Math.max(0, node.regrets[a] || 0);
    strat[a] = v;
    sum += v;
  }
  if (sum <= 1e-12) {
    const u = 1 / Math.max(1, legal.length);
    for (const a of legal) strat[a] = u;
    return strat;
  }
  for (const a of legal) strat[a] /= sum;
  return strat;
}

function estimateHsCached(ctx, state, player, trials, rand, cache) {
  const hand = ctx.hands[player];
  const key = `${canonicalCards(hand)}|${canonicalCards(state.board)}|${trials}`;
  if (cache.has(key)) return cache.get(key);
  const hs = evalStrengthRandomRange(hand, state.board, trials, rand, cache);
  cache.set(key, hs);
  return hs;
}

function cfr(ctx, inputState, traverser, rand, nodeMap, equityCache) {
  const state = cloneState(inputState);
  maybeProgressState(state, ctx.fullBoard);
  if (state.terminal) return terminalUtility(ctx, state, traverser);
  if (state.streetIdx === 0) return 0;

  const p = state.toAct;
  const legal = legalActions(state);
  if (!legal.length) {
    state.terminal = true;
    state.winner = 1 - p;
    return terminalUtility(ctx, state, traverser);
  }

  const hs = estimateHsCached(ctx, state, p, EQUITY_TRIALS_TRAIN, rand, equityCache);
  const tex = texture(state.board);
  const key = buildInfosetKey({ state, player: p, hs, tex });
  const node = ensureNode(nodeMap, key);
  node.visits += 1;
  for (const a of legal) node.legalSeen[a] = true;

  const strategy = currentStrategy(node, legal);
  for (const a of legal) node.strategySum[a] += strategy[a];

  if (p === traverser) {
    const util = Array(actionNames.length).fill(0);
    let nodeUtil = 0;
    for (const a of legal) {
      const ns = cloneState(state);
      applyAction(ns, a);
      const u = cfr(ctx, ns, traverser, rand, nodeMap, equityCache);
      util[a] = u;
      nodeUtil += strategy[a] * u;
    }
    for (const a of legal) {
      node.regrets[a] += util[a] - nodeUtil;
    }
    return nodeUtil;
  }

  const sampled = sampleActionByWeights(legal, strategy, rand);
  const ns = cloneState(state);
  applyAction(ns, sampled);
  return cfr(ctx, ns, traverser, rand, nodeMap, equityCache);
}

function exportPolicy(nodeMap) {
  const policy = {};
  for (const [key, node] of nodeMap.entries()) {
    const probs = Array(actionNames.length).fill(0);
    let sum = 0;
    for (let a = 0; a < actionNames.length; a++) {
      if (!node.legalSeen[a]) continue;
      const v = Math.max(0, Number(node.strategySum[a] || 0));
      probs[a] = v;
      sum += v;
    }
    if (sum <= 1e-12) {
      const legal = [];
      for (let a = 0; a < actionNames.length; a++) if (node.legalSeen[a]) legal.push(a);
      if (!legal.length) continue;
      const u = 1 / legal.length;
      for (const a of legal) probs[a] = u;
    } else {
      for (let a = 0; a < actionNames.length; a++) probs[a] /= sum;
    }
    policy[key] = probs.map((x) => Number(x.toFixed(8)));
  }
  return policy;
}

function policyDrift(prevPolicy, nextPolicy) {
  if (!prevPolicy) return { avg_l1: null, keys: Object.keys(nextPolicy).length, new_keys: Object.keys(nextPolicy).length };
  const keys = new Set([...Object.keys(prevPolicy), ...Object.keys(nextPolicy)]);
  let totalL1 = 0;
  let count = 0;
  let newKeys = 0;
  for (const key of keys) {
    const p = prevPolicy[key] || Array(actionNames.length).fill(0);
    const q = nextPolicy[key] || Array(actionNames.length).fill(0);
    if (!prevPolicy[key]) newKeys += 1;
    let l1 = 0;
    for (let i = 0; i < actionNames.length; i++) l1 += Math.abs((q[i] || 0) - (p[i] || 0));
    totalL1 += l1;
    count += 1;
  }
  return {
    avg_l1: count > 0 ? Number((totalL1 / count).toFixed(6)) : 0,
    keys: count,
    new_keys: newKeys,
  };
}

function chooseOpponentAction(profile, state, legal, rand) {
  const toCall = Math.max(0, state.currentBet - state.commit[state.toAct]);
  const pot = state.pot;
  const reqEq = toCall > 1e-9 ? (toCall / Math.max(1, pot + toCall)) : 0;
  const idx = new Map(legal.map((a) => [a, a]));

  if (profile === "nit") {
    if (toCall <= 1e-9) {
      if (idx.has(A.CHECK) && rand() < 0.93) return A.CHECK;
      if (idx.has(A.BET_HALF) && rand() < 0.06) return A.BET_HALF;
      if (idx.has(A.BET_POT) && rand() < 0.01) return A.BET_POT;
      return legal[0];
    }
    const foldP = Math.max(0.55, Math.min(0.92, 0.58 + reqEq * 0.8));
    if (idx.has(A.FOLD) && rand() < foldP) return A.FOLD;
    if (idx.has(A.CALL) && rand() < 0.92) return A.CALL;
    if (idx.has(A.RAISE_HALF) && rand() < 0.03) return A.RAISE_HALF;
    return idx.has(A.CALL) ? A.CALL : legal[0];
  }

  if (profile === "station") {
    if (toCall <= 1e-9) {
      if (idx.has(A.CHECK) && rand() < 0.66) return A.CHECK;
      if (idx.has(A.BET_HALF) && rand() < 0.28) return A.BET_HALF;
      if (idx.has(A.BET_POT) && rand() < 0.06) return A.BET_POT;
      return legal[0];
    }
    if (idx.has(A.CALL) && rand() < 0.90) return A.CALL;
    if (idx.has(A.FOLD) && rand() < 0.08) return A.FOLD;
    if (idx.has(A.RAISE_HALF) && rand() < 0.02) return A.RAISE_HALF;
    return idx.has(A.CALL) ? A.CALL : legal[0];
  }

  if (profile === "aggro") {
    if (toCall <= 1e-9) {
      if (idx.has(A.BET_HALF) && rand() < 0.55) return A.BET_HALF;
      if (idx.has(A.BET_POT) && rand() < 0.25) return A.BET_POT;
      if (idx.has(A.ALL_IN) && rand() < 0.03) return A.ALL_IN;
      if (idx.has(A.CHECK)) return A.CHECK;
      return legal[0];
    }
    if (idx.has(A.RAISE_HALF) && rand() < Math.max(0.18, 0.42 - reqEq * 0.5)) return A.RAISE_HALF;
    if (idx.has(A.RAISE_POT) && rand() < Math.max(0.08, 0.22 - reqEq * 0.35)) return A.RAISE_POT;
    if (idx.has(A.CALL) && rand() < 0.72) return A.CALL;
    if (idx.has(A.FOLD)) return A.FOLD;
    return legal[0];
  }

  if (toCall <= 1e-9) {
    if (idx.has(A.CHECK) && rand() < 0.84) return A.CHECK;
    if (idx.has(A.BET_HALF) && rand() < 0.15) return A.BET_HALF;
    return legal[0];
  }
  if (reqEq <= 0.33) {
    if (idx.has(A.RAISE_HALF) && reqEq < 0.16 && rand() < 0.10) return A.RAISE_HALF;
    if (idx.has(A.CALL)) return A.CALL;
  }
  return idx.has(A.FOLD) ? A.FOLD : legal[0];
}

function chooseBlueprintAction(policy, ctx, state, botSeat, rand, equityCache, equityTrials) {
  const legal = legalActions(state);
  if (!legal.length) return null;
  if (state.streetIdx === 0) {
    const hand = ctx.hands[botSeat];
    const tier = preflopTier(hand);
    const hs = preflopHsByTier(tier);
    const toCall = Math.max(0, state.currentBet - state.commit[botSeat]);
    const mix = buildPreflopMix(hand, legal, hs, toCall, state.raises);
    return sampleActionByWeights(legal, mix, rand);
  }
  const hs = estimateHsCached(ctx, state, botSeat, equityTrials, rand, equityCache);
  const tex = texture(state.board);
  const key = buildInfosetKey({ state, player: botSeat, hs, tex });
  const prior = policy[key];
  if (Array.isArray(prior) && prior.length >= actionNames.length) {
    return sampleActionByWeights(legal, prior, rand);
  }
  const toCall = Math.max(0, state.currentBet - state.commit[botSeat]);
  if (toCall <= 1e-9 && legal.includes(A.CHECK)) return A.CHECK;
  if (toCall > 1e-9 && legal.includes(A.CALL)) return A.CALL;
  return legal[0];
}

function evaluatePolicy(policy, evalSeed) {
  const out = {};
  let total = 0;
  let count = 0;
  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    const rand = makeRng((evalSeed + i * 100003) >>> 0);
    let sumEv = 0;
    for (let h = 0; h < EVAL_HANDS_PER_PROFILE; h++) {
      const botSeat = h % 2;
      const ctx = createHandContext(rand);
      const equityCache = new Map();
      while (!ctx.state.terminal) {
        maybeProgressState(ctx.state, ctx.fullBoard);
        if (ctx.state.terminal) break;
        const p = ctx.state.toAct;
        const legal = legalActions(ctx.state);
        if (!legal.length) {
          ctx.state.terminal = true;
          ctx.state.winner = 1 - p;
          break;
        }
        let action;
        if (p === botSeat) {
          action = chooseBlueprintAction(policy, ctx, ctx.state, botSeat, rand, equityCache, EQUITY_TRIALS_EVAL);
        } else {
          action = chooseOpponentAction(profile, ctx.state, legal, rand);
        }
        if (action == null || !legal.includes(action)) action = legal[0];
        applyAction(ctx.state, action);
      }
      const util = terminalUtility(ctx, ctx.state, botSeat);
      sumEv += util;
    }
    const evPerHand = Number((sumEv / Math.max(1, EVAL_HANDS_PER_PROFILE)).toFixed(4));
    out[profile] = { bot_ev_per_hand: evPerHand };
    total += evPerHand;
    count += 1;
  }
  out.aggregate = {
    avg_bot_ev_per_hand: Number((total / Math.max(1, count)).toFixed(4)),
    min_bot_ev_per_hand: Number(Math.min(...profiles.map((p) => out[p].bot_ev_per_hand)).toFixed(4)),
    max_bot_ev_per_hand: Number(Math.max(...profiles.map((p) => out[p].bot_ev_per_hand)).toFixed(4)),
  };
  return out;
}

function shouldStopByPlateau(checkpoints) {
  if (checkpoints.length < 3) return false;
  const last3 = checkpoints.slice(-3);
  if (last3.some((c) => c.policy_drift_avg_l1 == null)) return false;
  const driftFlat = last3.every((c) => c.policy_drift_avg_l1 <= DRIFT_PLATEAU_THRESHOLD);
  const evValues = last3.map((c) => c.eval.aggregate.avg_bot_ev_per_hand);
  const evRange = Math.max(...evValues) - Math.min(...evValues);
  return driftFlat && evRange <= EV_PLATEAU_THRESHOLD;
}

function savePolicy(outPath, iterations, policy, checkpoints, startedAt, finishedAt, stopReason) {
  const payload = {
    meta: {
      action_abstraction_version: "v1_locked_hu_2026_02",
      iterations,
      seed: SEED,
      started_at: startedAt,
      finished_at: finishedAt,
      equity_trials_train: EQUITY_TRIALS_TRAIN,
      equity_trials_eval: EQUITY_TRIALS_EVAL,
      checkpoint_every: CHECKPOINT_EVERY,
      eval_hands_per_profile: EVAL_HANDS_PER_PROFILE,
      max_raises: MAX_RAISES,
      blinds: { small: SMALL_BLIND, big: BIG_BLIND },
      start_stack: START_STACK,
      stop_reason: stopReason,
      checkpoints,
    },
    policy,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
}

function formatMb(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

function train() {
  const startedAtIso = new Date().toISOString();
  const startedMs = Date.now();
  const rand = makeRng(SEED);
  const nodeMap = new Map();
  let trainedHands = 0;
  let stopReason = "target_iterations_reached";
  let lastPolicy = null;
  const checkpoints = [];
  let completedIterations = 0;

  for (let iter = 1; iter <= TARGET_ITERS; iter++) {
    const traverser = iter % 2;
    const ctx = createHandContext(rand);
    runPreflopToPostflop(ctx, rand);
    if (ctx.state.terminal || ctx.state.streetIdx === 0) continue;

    const equityCache = new Map();
    cfr(ctx, ctx.state, traverser, rand, nodeMap, equityCache);
    trainedHands += 1;
    completedIterations = iter;

    if (iter % CHECKPOINT_EVERY !== 0) continue;

    const nowMs = Date.now();
    const elapsedSec = Math.max(1e-9, (nowMs - startedMs) / 1000);
    const itersPerSec = iter / elapsedSec;
    const policy = exportPolicy(nodeMap);
    const drift = policyDrift(lastPolicy, policy);
    const eval = evaluatePolicy(policy, SEED + iter * 17);
    const mem = process.memoryUsage();
    const checkpoint = {
      iter,
      trained_hands: trainedHands,
      infosets: nodeMap.size,
      iters_per_sec: Number(itersPerSec.toFixed(2)),
      memory_rss_mb: formatMb(mem.rss),
      memory_heap_used_mb: formatMb(mem.heapUsed),
      policy_drift_avg_l1: drift.avg_l1,
      policy_keys: drift.keys,
      policy_new_keys: drift.new_keys,
      eval,
      timestamp: new Date().toISOString(),
    };
    checkpoints.push(checkpoint);

    console.log(
      `[blueprint_v1] checkpoint iter=${iter} infosets=${nodeMap.size} ` +
      `iters_per_sec=${checkpoint.iters_per_sec} rss_mb=${checkpoint.memory_rss_mb} ` +
      `drift_l1=${checkpoint.policy_drift_avg_l1 ?? "n/a"} avg_ev=${eval.aggregate.avg_bot_ev_per_hand}`
    );

    if (WRITE_POLICY_EACH_CHECKPOINT) {
      const checkpointPath = `${OUT_PATH}.ckpt.${iter}.json`;
      savePolicy(
        checkpointPath,
        iter,
        policy,
        checkpoints,
        startedAtIso,
        checkpoint.timestamp,
        "checkpoint"
      );
    }

    if (iter >= MIN_ITERS_BEFORE_STOP && shouldStopByPlateau(checkpoints)) {
      stopReason = "plateau_reached";
      lastPolicy = policy;
      break;
    }
    lastPolicy = policy;
  }

  const finalPolicy = lastPolicy || exportPolicy(nodeMap);
  const finishedAtIso = new Date().toISOString();
  savePolicy(
    OUT_PATH,
    completedIterations,
    finalPolicy,
    checkpoints,
    startedAtIso,
    finishedAtIso,
    stopReason
  );

  const elapsedSec = Math.max(1e-9, (Date.now() - startedMs) / 1000);
  const summary = {
    out_path: OUT_PATH,
    stop_reason: stopReason,
    iterations: completedIterations,
    trained_hands: trainedHands,
    infoset_count: Object.keys(finalPolicy).length,
    iters_per_sec: Number((completedIterations / elapsedSec).toFixed(2)),
    memory_rss_mb: formatMb(process.memoryUsage().rss),
    checkpoints: checkpoints.length,
    last_drift_l1: checkpoints.length ? checkpoints[checkpoints.length - 1].policy_drift_avg_l1 : null,
  };
  console.log(JSON.stringify(summary, null, 2));
}

train();
