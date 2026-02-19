/**
 * Full-game Poker API (HU focused) with blinds + preflop->river progression.
 * Primary model path is C++ PokerBot blueprint + realtime solve (`solve-realtime`).
 * Blueprint v1 postflop prior is optional and blended with EV scoring.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const PokerEvaluator = require("poker-evaluator");
const {
  A,
  actionNames,
  legalActions: legalActionsShared,
  actionTarget: actionTargetShared,
} = require("./lib/action_model.cjs");
const {
  texture: infosetTexture,
  buildInfosetKey,
  hsBand,
} = require("./lib/infoset_v1.cjs");

// Config
const PORT = Number(process.env.PORT || 8787);
const BUCKETS_PATH = process.env.BUCKETS_PATH || "C:/out/PokerBot/data/blueprint_buckets_v1_200.json";
const BLUEPRINT_PATH = process.env.BLUEPRINT_PATH || "C:/out/Poker/data/cpp_fullgame_blueprint_v1.strategy.tsv";
const START_STACK = Number(process.env.START_STACK || 200);
const SMALL_BLIND = Number(process.env.SMALL_BLIND || 1);
const BIG_BLIND = Number(process.env.BIG_BLIND || 2);
const MAX_RAISES = Number(process.env.MAX_RAISES || 3);
const EQUITY_TRIALS = Number(process.env.EQUITY_TRIALS || 600);
const BLUEPRINT_V1_PATH = process.env.BLUEPRINT_V1_PATH || process.env.POSTFLOP_PRIOR_PATH || path.join(__dirname, "data", "postflop_blueprint_v1.json");
const BLUEPRINT_V1_EV_BLEND = Number(process.env.BLUEPRINT_V1_EV_BLEND || process.env.POSTFLOP_PRIOR_BLEND || 0.4);
const BLUEPRINT_V1_PRIOR_PROB_FLOOR = Number(process.env.BLUEPRINT_V1_PRIOR_PROB_FLOOR || 1e-4);
const RT_SUBGAME_MS = Math.max(200, Math.min(800, Number(process.env.RT_SUBGAME_MS || 300)));
const RT_SUBGAME_DEPTH = Math.max(2, Math.min(8, Number(process.env.RT_SUBGAME_DEPTH || 5)));
const RT_TRIGGER_POT = Number(process.env.RT_TRIGGER_POT || 60);
const RT_TRIGGER_SPR = Number(process.env.RT_TRIGGER_SPR || 4);
const RT_PRIOR_WEIGHT = Math.max(0, Math.min(1, Number(process.env.RT_PRIOR_WEIGHT || 0.65)));
const ENABLE_BLUEPRINT_V1_PRIOR = String(process.env.ENABLE_BLUEPRINT_V1_PRIOR || process.env.ENABLE_JS_POSTFLOP_PRIOR || "1") !== "0";
const ENABLE_RT = String(process.env.ENABLE_RT || "1") !== "0";
const SEATS = Number(process.env.SEATS || 2); // allow HU for now
const ACTION_ABSTRACTION = Object.freeze({
  version: "v1_locked_hu_2026_02",
  preflop: Object.freeze({
    actions: Object.freeze(["FOLD", "CHECK", "CALL", "RAISE_HALF_POT", "RAISE_POT", "ALL_IN"]),
    max_raises: MAX_RAISES,
  }),
  postflop: Object.freeze({
    actions: Object.freeze(["FOLD", "CHECK", "CALL", "BET_HALF_POT", "BET_POT", "RAISE_HALF_POT", "RAISE_POT", "ALL_IN"]),
    max_raises: MAX_RAISES,
  }),
  blinds: Object.freeze({ small: SMALL_BLIND, big: BIG_BLIND }),
  start_stack: START_STACK,
});

const streets = ["preflop", "flop", "turn", "river"];
const ENGINE_DIAG = {
  board_invariant_warnings: 0,
  eval_suspect_warnings: 0,
  illegal_state_warnings: 0,
  postflop_prior_hits: 0,
  postflop_prior_misses: 0,
  rt_subgame_hits: 0,
  rt_subgame_fallbacks: 0,
};

function warnDiag(kind, msg) {
  if (ENGINE_DIAG[kind] != null) ENGINE_DIAG[kind] += 1;
  console.warn(msg);
}

// Bucket helpers
function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function loadBuckets() {
  const j = readJson(BUCKETS_PATH);
  const res = { flop: 200, turn: 200, river: 200 };
  ["flop", "turn", "river"].forEach((s) => {
    res[s] = (j.streets?.[s]?.centroids || []).length || res[s];
  });
  return res;
}
const bucketCounts = loadBuckets();
function sampleBucket(street) {
  const k = bucketCounts[street] || 200;
  return Math.floor(Math.random() * k);
}

function loadPostflopPrior(p) {
  const disabled = { enabled: false, path: p, map: new Map(), meta: null };
  try {
    if (!p || !fs.existsSync(p)) return disabled;
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw);
    const infosets = j?.policy || j?.infosets || {};
    const map = new Map();
    for (const [k, probsRaw] of Object.entries(infosets)) {
      if (!Array.isArray(probsRaw) || probsRaw.length < actionNames.length) continue;
      const probs = probsRaw.slice(0, actionNames.length).map((v) => Math.max(0, Number(v) || 0));
      const sum = probs.reduce((a, b) => a + b, 0);
      if (sum <= 1e-9) continue;
      map.set(k, probs.map((v) => v / sum));
    }
    return { enabled: map.size > 0, path: p, map, meta: j?.meta || null };
  } catch (err) {
    console.warn(`POSTFLOP_PRIOR_LOAD_ERROR path=${p} err=${err?.message || err}`);
    return disabled;
  }
}
const postflopPrior = ENABLE_BLUEPRINT_V1_PRIOR
  ? loadPostflopPrior(BLUEPRINT_V1_PATH)
  : {
      enabled: false,
      path: BLUEPRINT_V1_PATH,
      map: new Map(),
      meta: { disabled_by_default: true, reason: "ENABLE_BLUEPRINT_V1_PRIOR=0" },
    };

// Card helpers (index 0..51)
const ranks = "23456789TJQKA";
const suits = "shdc";
function cardFromIndex(i) { return ranks[i % 13] + suits[Math.floor(i / 13)]; }
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
function dealDeck() {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  shuffle(deck);
  return deck;
}

// EV guard
function removeDominatedFold(legal, toCall, pot, equity, margin = 0.02) {
  if (!legal.includes(A.FOLD)) return legal;
  if (toCall <= 1e-9) return legal;
  const req = toCall / (pot + toCall);
  if (equity <= req + margin) return legal;
  return legal.filter((a) => a !== A.FOLD);
}

function boardDesc(board) {
  return `${board.length}c:[${board.join(",") || "-"}]`;
}

function boardRanksArray(board) {
  return board.map((c) => c[0]);
}

function boardSuitCounts(board) {
  const counts = {};
  for (const c of board) {
    const s = c[1];
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

function isPaired(board) {
  const ranksOnly = boardRanksArray(board);
  return new Set(ranksOnly).size < ranksOnly.length;
}

function isMonotone(board) {
  if (board.length < 3) return false;
  return Object.keys(boardSuitCounts(board)).length === 1;
}

function isConnected(board) {
  if (board.length < 3) return false;
  const values = [...new Set(board.map((c) => rankValue(c)))].sort((a, b) => a - b);
  if (values.length < 3) return false;
  let closePairs = 0;
  for (let i = 1; i < values.length; i++) {
    if ((values[i] - values[i - 1]) <= 2) closePairs += 1;
  }
  return closePairs >= 2;
}

function boardTexture(board) {
  const tex = infosetTexture(board);
  const paired = tex.paired;
  const monotone = tex.monotone;
  const connected = tex.connected;
  const twoTone = tex.twoTone;
  const wet = monotone || twoTone || connected;
  const dry = !wet && !paired;
  return { paired, monotone, connected, twoTone, wet, dry };
}

// Real equity via Monte Carlo vs specific opponent range (here: exact opponent hand if known, else random)
function evalStrength(heroHand, board, oppHand = null, trials = 300) {
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push(`${r}${s}`);
  const used = new Set([...heroHand, ...board, ...(oppHand || [])]);
  const avail = deck.filter((c) => !used.has(c));

  if (heroHand.length !== 2) return { eq: 0.5, samples: 0, err: "bad_hero" }; // guard

  let wins = 0, ties = 0, total = 0;
  for (let t = 0; t < trials; t++) {
    const opp = oppHand
      ? [...oppHand]
      : (() => {
          const pool = [...avail];
          const i1 = Math.floor(Math.random() * pool.length);
          const c1 = pool.splice(i1, 1)[0];
          const i2 = Math.floor(Math.random() * pool.length);
          const c2 = pool.splice(i2, 1)[0];
          return [c1, c2];
        })();
    const need = 5 - board.length;
    const pool = avail.filter((c) => !opp.includes(c));
    const boardFill = [...board];
    for (let k = 0; k < need; k++) {
      const ix = Math.floor(Math.random() * pool.length);
      boardFill.push(pool.splice(ix, 1)[0]);
    }
    const heroEval = PokerEvaluator.evalHand([...heroHand, ...boardFill]);
    const oppEval = PokerEvaluator.evalHand([...opp, ...boardFill]);
    if (heroEval.value > oppEval.value) wins += 1;
    else if (heroEval.value === oppEval.value) ties += 1;
    total += 1;
  }
  const eq = total ? (wins + 0.5 * ties) / total : 0.5;
  const err = total < 20 ? "low_samples" : null;
  return { eq, samples: total, err };
}

function rankValue(card) {
  return ranks.indexOf(card[0]) + 2;
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

function getOpponentPreflopProfile(sess) {
  const s = sess.stats || {};
  const facing = s.human_facing_raise_preflop || 0;
  const threebets = s.human_threebet_preflop || 0;
  const calls = s.human_call_vs_raise_preflop || 0;
  return {
    threeBetRate: facing > 0 ? threebets / facing : 0.15,
    callRate: facing > 0 ? calls / facing : 0.50,
  };
}

function defaultPostflopStreetStats() {
  return {
    facing_bet: 0,
    fold_vs_bet: 0,
    call_vs_bet: 0,
    raise_vs_bet: 0,
  };
}

function ensureSessionStats(sess) {
  if (!sess.stats) sess.stats = {};
  if (sess.stats.human_facing_raise_preflop == null) sess.stats.human_facing_raise_preflop = 0;
  if (sess.stats.human_threebet_preflop == null) sess.stats.human_threebet_preflop = 0;
  if (sess.stats.human_call_vs_raise_preflop == null) sess.stats.human_call_vs_raise_preflop = 0;
  if (!sess.stats.postflop) {
    sess.stats.postflop = {
      flop: defaultPostflopStreetStats(),
      turn: defaultPostflopStreetStats(),
      river: defaultPostflopStreetStats(),
    };
  }
  return sess.stats;
}

function initialRangeBelief() {
  return { weak: 0.34, medium: 0.33, strong: 0.33 };
}

function normalizeRangeBelief(belief) {
  const out = {
    weak: Math.max(0, Number(belief?.weak || 0)),
    medium: Math.max(0, Number(belief?.medium || 0)),
    strong: Math.max(0, Number(belief?.strong || 0)),
  };
  let s = out.weak + out.medium + out.strong;
  if (s <= 1e-9) {
    out.weak = 0.34;
    out.medium = 0.33;
    out.strong = 0.33;
    return out;
  }
  out.weak /= s;
  out.medium /= s;
  out.strong /= s;
  return out;
}

function ensureRangeBeliefs(sess) {
  if (!Array.isArray(sess.rangeBeliefs) || sess.rangeBeliefs.length < 2) {
    sess.rangeBeliefs = [initialRangeBelief(), initialRangeBelief()];
  }
  sess.rangeBeliefs[0] = normalizeRangeBelief(sess.rangeBeliefs[0]);
  sess.rangeBeliefs[1] = normalizeRangeBelief(sess.rangeBeliefs[1]);
  return sess.rangeBeliefs;
}

function getRangeBelief(sess, seat) {
  const beliefs = ensureRangeBeliefs(sess);
  return beliefs[seat] || initialRangeBelief();
}

function updateRangeBeliefFromAction(sess, seat, act, toCallBefore) {
  const beliefs = ensureRangeBeliefs(sess);
  const b = { ...beliefs[seat] };
  const facingBet = toCallBefore > 1e-9;
  const isAggressive =
    act === A.BET_HALF ||
    act === A.BET_POT ||
    act === A.RAISE_HALF ||
    act === A.RAISE_POT ||
    act === A.ALL_IN;
  if (facingBet) {
    if (act === A.FOLD) {
      b.weak += 0.20;
      b.medium += 0.04;
      b.strong -= 0.24;
    } else if (act === A.CALL || act === A.CHECK) {
      b.weak -= 0.05;
      b.medium += 0.12;
      b.strong -= 0.07;
    } else if (isAggressive) {
      b.weak -= 0.16;
      b.medium -= 0.04;
      b.strong += 0.20;
    }
  } else {
    if (act === A.CHECK) {
      b.weak += 0.10;
      b.medium += 0.02;
      b.strong -= 0.12;
    } else if (isAggressive) {
      b.weak -= 0.12;
      b.medium -= 0.02;
      b.strong += 0.14;
    }
  }
  beliefs[seat] = normalizeRangeBelief(b);
}

function conditionedEquity(baseEq, oppBelief) {
  const b = normalizeRangeBelief(oppBelief || initialRangeBelief());
  const pressure = (b.strong - b.weak);
  const adj = -0.11 * pressure + 0.02 * (b.medium - 0.33);
  return clamp(baseEq + adj, 0.001, 0.999);
}

function getOpponentPostflopProfile(sess, street) {
  const s = ensureSessionStats(sess);
  const st = s.postflop?.[street] || defaultPostflopStreetStats();
  const facing = st.facing_bet || 0;
  return {
    foldRate: facing > 0 ? st.fold_vs_bet / facing : 0.34,
    callRate: facing > 0 ? st.call_vs_bet / facing : 0.54,
    raiseRate: facing > 0 ? st.raise_vs_bet / facing : 0.12,
    samples: facing,
  };
}

function actionAggressionScore(act) {
  switch (act) {
    case A.FOLD: return 0;
    case A.CHECK: return 1;
    case A.CALL: return 2;
    case A.BET_HALF: return 3;
    case A.RAISE_HALF: return 4;
    case A.BET_POT: return 5;
    case A.RAISE_POT: return 6;
    case A.ALL_IN: return 7;
    default: return 10;
  }
}

function pickActionByEV(legal, evByAct, tolerance = 0.12) {
  if (!legal.length) return null;
  let bestEV = -Infinity;
  for (const a of legal) {
    const ev = evByAct.get(a) ?? -Infinity;
    if (ev > bestEV) bestEV = ev;
  }
  const nearBest = legal.filter((a) => (bestEV - (evByAct.get(a) ?? -Infinity)) <= tolerance);
  nearBest.sort((a, b) => actionAggressionScore(a) - actionAggressionScore(b));
  return nearBest[0] ?? legal[0];
}

function getPostflopPriorProbs(state, player, hs, texture) {
  if (!postflopPrior.enabled || state.streetIdx <= 0 || BLUEPRINT_V1_EV_BLEND >= 1) return null;
  const key = buildInfosetKey({ state, player, hs, tex: texture });
  const probs = postflopPrior.map.get(key);
  if (probs) {
    ENGINE_DIAG.postflop_prior_hits += 1;
    return { key, probs };
  }
  ENGINE_DIAG.postflop_prior_misses += 1;
  return { key, probs: null };
}

function blendEvWithPrior(legal, evByAct, priorProbs, evBlend = 0.4) {
  if (!priorProbs || !legal.length || evBlend >= 1) return evByAct;
  const evWeight = Math.max(0, Math.min(1, evBlend));
  const priorWeight = 1 - evWeight;
  const priorFloor = Math.max(1e-12, BLUEPRINT_V1_PRIOR_PROB_FLOOR);
  const blended = new Map();
  for (const a of legal) {
    const ev = Number(evByAct.get(a) ?? 0);
    const prior = Math.max(priorFloor, Number(priorProbs[a] || 0));
    const score = evWeight * ev + priorWeight * Math.log(prior);
    blended.set(a, score);
  }
  return blended;
}

function scoresToActionProbs(legal, scoreByAct, temp = 0.35) {
  const probs = Array(actionNames.length).fill(0);
  if (!legal.length) return probs;
  let maxScore = -Infinity;
  for (const a of legal) {
    const s = Number(scoreByAct.get(a) ?? -Infinity);
    if (s > maxScore) maxScore = s;
  }
  let z = 0;
  for (const a of legal) {
    const s = Number(scoreByAct.get(a) ?? -Infinity);
    const p = Math.exp((s - maxScore) / Math.max(1e-6, temp));
    probs[a] = p;
    z += p;
  }
  if (z <= 1e-12) {
    const u = 1 / legal.length;
    for (const a of legal) probs[a] = u;
    return probs;
  }
  for (const a of legal) probs[a] /= z;
  return probs;
}

function toLegalPrior(legal, priorProbs = null) {
  const arr = legal.map((a) => Math.max(0, Number(priorProbs?.[a] || 0)));
  let s = arr.reduce((acc, v) => acc + v, 0);
  if (s <= 1e-12) {
    const u = 1 / Math.max(1, legal.length);
    return legal.map(() => u);
  }
  return arr.map((v) => v / s);
}

function shouldRunRtSubgame(sess, seat, spr) {
  if (!ENABLE_RT) return false;
  if (sess.state.terminal) return false;
  if (sess.state.toAct !== seat) return false;
  if (!(sess.state.street === "turn" || sess.state.street === "river")) return false;
  if (bettingClosedAllIn(sess)) return false;
  if (sess.state.pot >= RT_TRIGGER_POT) return true;
  return Number.isFinite(spr) && spr <= RT_TRIGGER_SPR;
}

function subgameLeafEV(state, hs, act, texture, oppProfile, oppRangeBelief, depthLimit = 2) {
  const base = estimateEV(state, hs, act, texture, oppProfile, oppRangeBelief);
  if (depthLimit <= 1) return base;
  const pay = Math.max(0, actionTarget(state, act) - state.commit[state.toAct]);
  const tension = pay / Math.max(1, state.pot);
  const range = normalizeRangeBelief(oppRangeBelief || initialRangeBelief());
  const strongTilt = range.strong - range.weak;
  const continuation =
    (hs - 0.5 - 0.25 * strongTilt) *
    Math.max(1, state.pot * 0.24) *
    ((depthLimit - 1) / Math.max(1, depthLimit));
  const depthPenalty = 0.06 * tension * Math.max(1, pay);
  return base + continuation - depthPenalty;
}

function solveRtSubgameDCFR({
  state,
  legal,
  hs,
  texture,
  oppProfile,
  oppRangeBelief,
  priorProbs = null,
  thinkMs = RT_SUBGAME_MS,
  depthLimit = RT_SUBGAME_DEPTH,
}) {
  if (!legal.length) return null;
  const start = Date.now();
  const priorLegal = toLegalPrior(legal, priorProbs);
  const regrets = legal.map(() => 0);
  const strategySum = legal.map(() => 0);
  let iterations = 0;

  const maxMs = Math.max(200, Math.min(800, thinkMs));
  while ((Date.now() - start) < maxMs) {
    iterations += 1;
    const positive = regrets.map((r) => Math.max(0, r));
    let posSum = positive.reduce((acc, v) => acc + v, 0);
    let strategy = null;
    if (posSum <= 1e-12) {
      strategy = [...priorLegal];
    } else {
      strategy = positive.map((v) => v / posSum);
      for (let i = 0; i < strategy.length; i++) {
        strategy[i] = (1 - RT_PRIOR_WEIGHT) * strategy[i] + RT_PRIOR_WEIGHT * priorLegal[i];
      }
      const z = strategy.reduce((acc, v) => acc + v, 0) || 1;
      strategy = strategy.map((v) => v / z);
    }

    const util = legal.map((act, i) => {
      const noise = (Math.random() - 0.5) * 0.004 * Math.max(1, state.pot);
      const e = subgameLeafEV(state, hs, act, texture, oppProfile, oppRangeBelief, depthLimit);
      return e + noise;
    });

    let nodeUtil = 0;
    for (let i = 0; i < strategy.length; i++) nodeUtil += strategy[i] * util[i];
    const t = Math.max(1, iterations);
    const alpha = Math.pow(t, 1.5);
    const beta = Math.pow(t, 0.5);
    const posDisc = alpha / (alpha + 1);
    const negDisc = beta / (beta + 2);
    for (let i = 0; i < regrets.length; i++) {
      const diff = util[i] - nodeUtil;
      regrets[i] = (diff >= 0 ? regrets[i] * posDisc : regrets[i] * negDisc) + diff;
      strategySum[i] += strategy[i];
    }
  }

  const out = Array(actionNames.length).fill(0);
  let sum = strategySum.reduce((acc, v) => acc + Math.max(0, v), 0);
  if (sum <= 1e-12) {
    for (let i = 0; i < legal.length; i++) {
      out[legal[i]] = priorLegal[i];
    }
  } else {
    for (let i = 0; i < legal.length; i++) {
      out[legal[i]] = Math.max(0, strategySum[i]) / sum;
    }
  }

  return {
    probs: out.map((v) => Number(v.toFixed(6))),
    iterations,
    elapsed_ms: Date.now() - start,
  };
}

function applyConservativeOverride(state, legal, chosen, hs, texture, spr) {
  if (chosen == null) return chosen;
  const toCall = Math.max(0, state.currentBet - state.commit[state.toAct]);
  const reqEq = toCall > 1e-9 ? (toCall / Math.max(1, state.pot + toCall)) : 0;
  const canCall = legal.includes(A.CALL);
  const canCheck = legal.includes(A.CHECK);
  const canBetHalf = legal.includes(A.BET_HALF);
  const canRaiseHalf = legal.includes(A.RAISE_HALF);

  if (texture?.paired && hs > 0.40 && hs < 0.70 && spr > 2) {
    if (toCall > 1e-9 && canCall) return A.CALL;
    if (toCall <= 1e-9 && canCheck) return A.CHECK;
  }

  if (chosen === A.ALL_IN && spr > 1.5 && hs < 0.70) {
    if (toCall > 1e-9 && canCall) return A.CALL;
    if (toCall <= 1e-9 && canCheck) return A.CHECK;
  }

  if (chosen === A.BET_POT || chosen === A.RAISE_POT) {
    if (texture?.dry && hs < 0.68) {
      if (toCall > 1e-9 && canCall) return A.CALL;
      if (toCall <= 1e-9 && canCheck) return A.CHECK;
      if (toCall <= 1e-9 && canBetHalf) return A.BET_HALF;
      if (canCheck) return A.CHECK;
    }
    if (hs < 0.58 && spr > 2 && !texture?.wet) {
      if (toCall > 1e-9 && canCall) return A.CALL;
      if (toCall <= 1e-9 && canCheck) return A.CHECK;
      if (toCall <= 1e-9 && canBetHalf) return A.BET_HALF;
      if (canCheck) return A.CHECK;
    }
  }

  if ((chosen === A.RAISE_HALF || chosen === A.RAISE_POT) && toCall > 1e-9) {
    if (hs < reqEq + 0.18) {
      if (canCall) return A.CALL;
    }
    if (hs < 0.58 && spr > 2 && !texture?.wet) {
      if (canCall) return A.CALL;
      if (canRaiseHalf) return A.RAISE_HALF;
    }
  }

  if ((chosen === A.BET_HALF || chosen === A.BET_POT) && toCall <= 1e-9 && spr > 3) {
    if (hs < 0.55 && canCheck) return A.CHECK;
    if (texture?.dry && hs < 0.60 && canCheck) return A.CHECK;
  }

  return chosen;
}

function normalizeWeights(weights, legal) {
  let sum = 0;
  for (const a of legal) sum += Math.max(0, weights[a] || 0);
  if (sum <= 1e-9) {
    const uniform = 1 / Math.max(1, legal.length);
    for (const a of legal) weights[a] = uniform;
    return weights;
  }
  for (const a of legal) weights[a] = Math.max(0, weights[a] || 0) / sum;
  return weights;
}

function buildPreflopMix(sess, hand, legal, hs, toCall) {
  const tier = preflopTier(hand);
  const profile = getOpponentPreflopProfile(sess);
  let raise = 0.0;
  let call = 0.0;
  let passive = 0.0;

  const facingRaise = toCall > 1e-9 && (sess.state?.raises || 0) >= 1;
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

  // Adaptation based on observed human 3-bet tendencies
  if (profile.threeBetRate > 0.28) {
    if (tier === "medium" || tier === "speculative" || tier === "trash") {
      raise = Math.max(0, raise - 0.18);
      passive = Math.min(1, passive + 0.16);
    }
    if (tier === "premium" || tier === "strong") {
      raise = Math.min(1, raise + 0.06);
      call = Math.max(0, call - 0.04);
    }
  } else if (profile.threeBetRate < 0.10 && profile.callRate > 0.45) {
    if (tier === "premium" || tier === "strong" || tier === "medium") {
      raise = Math.min(1, raise + 0.10);
      passive = Math.max(0, passive - 0.06);
    } else {
      raise = Math.max(0, raise - 0.08);
      passive = Math.min(1, passive + 0.08);
    }
  }

  // Mild equity-based correction
  if (hs < 0.42) {
    raise = Math.max(0, raise - 0.10);
    passive = Math.min(1, passive + 0.10);
  } else if (hs > 0.62) {
    raise = Math.min(1, raise + 0.08);
    passive = Math.max(0, passive - 0.06);
  }

  const weights = {};
  for (const a of legal) weights[a] = 0;
  const hasRaiseHalf = legal.includes(A.RAISE_HALF);
  const hasRaisePot = legal.includes(A.RAISE_POT);
  if (hasRaiseHalf || hasRaisePot) {
    const potShare = tier === "premium" ? 0.24 : 0.10;
    if (hasRaiseHalf) weights[A.RAISE_HALF] = raise * (hasRaisePot ? 1 - potShare : 1);
    if (hasRaisePot) weights[A.RAISE_POT] = raise * (hasRaiseHalf ? potShare : 1);
  }
  if (legal.includes(A.CALL)) weights[A.CALL] = call;
  if (legal.includes(A.CHECK)) weights[A.CHECK] = passive;
  if (legal.includes(A.FOLD) && !legal.includes(A.CHECK)) weights[A.FOLD] = passive;
  if (legal.includes(A.ALL_IN)) {
    weights[A.ALL_IN] = hs > 0.80 ? 0.08 : 0.0;
  }

  return {
    tier,
    profile,
    weights: normalizeWeights(weights, legal),
  };
}

function sampleActionWithMix(legal, evByAct, mixWeights, blend = 0.55, temp = 0.85) {
  const scores = [];
  for (const a of legal) {
    const ev = evByAct.get(a) ?? 0;
    const w = Math.max(1e-6, mixWeights[a] ?? (1 / Math.max(1, legal.length)));
    const score = blend * ev + (1 - blend) * Math.log(w);
    scores.push(score);
  }
  const maxScore = Math.max(...scores);
  const exp = scores.map((s) => Math.exp((s - maxScore) / temp));
  const z = exp.reduce((acc, v) => acc + v, 0) || 1;
  let r = Math.random() * z;
  for (let i = 0; i < legal.length; i++) {
    r -= exp[i];
    if (r <= 0) return legal[i];
  }
  return legal[legal.length - 1];
}

function legalActions(state) {
  return legalActionsShared(state, MAX_RAISES, BIG_BLIND);
}

function actionTarget(state, act) {
  return actionTargetShared(state, act, BIG_BLIND);
}

function sprValue(state, seat) {
  return state.pot > 0 ? state.stack[seat] / Math.max(1, state.pot) : Infinity;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function estimateEV(state, hs, act, texture = null, oppProfile = null, oppRangeBelief = null) {
  const p = state.toAct;
  const toCall = Math.max(0, state.currentBet - state.commit[p]);
  const pay = Math.max(0, actionTarget(state, act) - state.commit[p]);
  const potNow = state.pot;
  const potAfterPay = potNow + pay;
  const spr = sprValue(state, p);

  if (act === A.FOLD) return 0;
  if (act === A.CHECK) return hs * potNow;
  if (act === A.CALL) {
    const realize =
      texture?.wet ? 0.90 :
      texture?.paired ? 0.95 :
      0.93;
    const base = hs * potNow - (1 - hs) * toCall;
    return base * realize;
  }

  // Bet / raise / all-in: opponent reacts to pot odds and sizing, not our hidden equity.
  const oppToCall = pay;
  const oppReqEq = oppToCall / Math.max(1, potAfterPay + oppToCall);
  const betFrac = oppToCall / Math.max(1, potNow);
  const callProbBase =
    0.84 - 0.95 * oppReqEq - 0.30 * Math.max(0, betFrac - 0.5);
  let callProb = clamp(callProbBase, 0.15, 0.84);
  let raiseProb = clamp(0.10 - 0.08 * oppReqEq, 0.02, 0.08);
  if (oppRangeBelief) {
    const b = normalizeRangeBelief(oppRangeBelief);
    const strengthTilt = b.strong - b.weak;
    callProb = clamp(callProb + 0.18 * strengthTilt, 0.10, 0.90);
    raiseProb = clamp(raiseProb + 0.10 * strengthTilt, 0.01, 0.24);
  }
  let foldProb = Math.max(0, 1 - callProb - raiseProb);
  if (oppProfile && oppProfile.samples >= 8) {
    foldProb = clamp(0.6 * foldProb + 0.4 * oppProfile.foldRate, 0.06, 0.85);
    raiseProb = clamp(0.7 * raiseProb + 0.3 * oppProfile.raiseRate, 0.01, 0.20);
    callProb = Math.max(0.03, 1 - foldProb - raiseProb);
    const z = callProb + foldProb + raiseProb;
    callProb /= z;
    foldProb /= z;
    raiseProb /= z;
  }

  // Incremental EV (relative to current state): when opponent folds we win current pot, not our own bet.
  const evIfFold = potNow;
  const oppCallAmount = pay;
  const evIfCall = hs * (potNow + oppCallAmount) - (1 - hs) * pay;
  const evIfRaise = evIfCall - 0.35 * pay;

  let penalty = 0;
  if (hs >= 0.4 && hs <= 0.65 && spr > 2) penalty += 0.16 * pay;
  if (texture?.paired && hs <= 0.65 && spr > 2) penalty += 0.12 * pay;
  if (texture?.dry && (act === A.BET_POT || act === A.RAISE_POT)) penalty += 0.18 * pay;
  if (texture?.wet && hs >= 0.62) penalty -= 0.06 * pay;
  if (act === A.ALL_IN && spr > 6) penalty += 0.35 * pay;
  if (toCall <= 1e-9 && hs < 0.62 && spr > 2) {
    if (act === A.BET_HALF) penalty += 0.18 * pay;
    if (act === A.BET_POT || act === A.RAISE_POT) penalty += 0.34 * pay;
  }
  if (toCall > 1e-9 && hs >= 0.4 && hs <= 0.65 && spr > 2) {
    if (act === A.RAISE_HALF) penalty += 0.22 * pay;
    if (act === A.RAISE_POT || act === A.ALL_IN) penalty += 0.30 * pay;
  }
  if (oppProfile && oppProfile.samples >= 10 && hs < 0.58 && pay > 0) {
    if (oppProfile.foldRate < 0.28) penalty += 0.14 * pay;
    if (oppProfile.raiseRate > 0.18) penalty += 0.10 * pay;
  }

  return foldProb * evIfFold + callProb * evIfCall + raiseProb * evIfRaise - penalty;
}

function enforceBoardInvariant(sess) {
  const expected = [0, 3, 4, 5][sess.state.streetIdx] || 0;
  if (sess.board.length !== expected) {
    warnDiag("board_invariant_warnings", `BOARD_INVARIANT street=${sess.state.street} expected=${expected} got=${sess.board.length} board=${boardDesc(sess.board)} full=${boardDesc(sess.fullBoard)}`);
    sess.board = sess.fullBoard.slice(0, expected);
  }
}

function applyAction(state, act) {
  const p = state.toAct;
  const o = 1 - p;
  const toCall = Math.max(0, state.currentBet - state.commit[p]);
  if (act === A.CALL && toCall <= 1e-9) {
    // normalize impossible call to check
    act = A.CHECK;
  }
  const target = actionTarget(state, act);
  if (!Number.isFinite(target) || target < state.commit[p] - 1e-9) {
    warnDiag("illegal_state_warnings", `ILLEGAL_TARGET act=${actionNames[act] || act} target=${target} commit=${state.commit[p]} toCall=${toCall}`);
  }
  const resetActed = () => { state.acted = [false, false]; };
  if (act === A.FOLD) {
    state.terminal = true;
    state.winner = o;
    state.history += "f";
    state.acted[p] = true;
    return;
  }
  if (act === A.CHECK) {
    state.history += "k";
    state.consecutiveChecks += 1;
    state.toAct = o;
    state.acted[p] = true;
    return;
  }
  // commit chips
  const pay = target - state.commit[p];
  const realPay = Math.min(pay, state.stack[p]);
  state.stack[p] -= realPay;
  state.commit[p] += realPay;
  state.pot += realPay;
  if (state.stack[p] < -1e-6 || state.commit[p] < -1e-6 || state.pot < -1e-6) {
    warnDiag("illegal_state_warnings", `NEGATIVE_STATE stack=${state.stack[p]} commit=${state.commit[p]} pot=${state.pot}`);
  }
  state.consecutiveChecks = 0;
  state.history += actionNames[act][0].toLowerCase();
  if (act === A.CALL || act === A.ALL_IN) {
    state.acted[p] = true;
    if (state.commit[p] > state.currentBet) {
      state.currentBet = state.commit[p];
      state.raises += 1;
      resetActed();
      state.acted[p] = true;
    }
    state.toAct = o;
    return;
  }
  if (act === A.BET_HALF || act === A.BET_POT || act === A.RAISE_HALF || act === A.RAISE_POT) {
    state.currentBet = state.commit[p];
    state.raises += 1;
    resetActed();
    state.acted[p] = true;
    state.toAct = o;
    return;
  }
}

function newHand(humanSeat, handIndex) {
  const deck = dealDeck();
  const hero = [cardFromIndex(deck.pop()), cardFromIndex(deck.pop())];
  const vill = [cardFromIndex(deck.pop()), cardFromIndex(deck.pop())];
  const fullBoard = Array.from({ length: 5 }, () => cardFromIndex(deck.pop()));
  const state = {
    streetIdx: 0,
    street: "preflop",
    pot: SMALL_BLIND + BIG_BLIND,
    currentBet: BIG_BLIND,
    commit: [SMALL_BLIND, BIG_BLIND],
    stack: [START_STACK - SMALL_BLIND, START_STACK - BIG_BLIND],
    raises: 0,
    consecutiveChecks: 0,
    acted: [false, false],
    history: "",
    terminal: false,
    winner: -1,
    toAct: 0, // SB acts first preflop
  };
  return {
    humanSeat,
    handIndex,
    hero,
    vill,
    board: [],
    fullBoard,
    state,
    resolved: false,
    lastResult: null,
    rangeBeliefs: [initialRangeBelief(), initialRangeBelief()],
  };
}

function settleTerminal(sess) {
  if (sess.resolved && sess.lastResult) return sess.lastResult;
  const wasFold = sess.state.history.endsWith("f");
  let winner = sess.state.winner;
  if (winner !== 0 && winner !== 1) {
    const board = sess.fullBoard.slice(0, 5);
    const p0 = PokerEvaluator.evalHand([...sess.hero, ...board]);
    const p1 = PokerEvaluator.evalHand([...sess.vill, ...board]);
    if (p0.value > p1.value) winner = 0;
    else if (p1.value > p0.value) winner = 1;
    else winner = -1;
    sess.state.winner = winner;
  }

  const finalStacks = [sess.state.stack[0], sess.state.stack[1]];
  if (winner === 0 || winner === 1) {
    finalStacks[winner] += sess.state.pot;
  } else {
    finalStacks[0] += sess.state.pot * 0.5;
    finalStacks[1] += sess.state.pot * 0.5;
  }

  const humanEV = finalStacks[sess.humanSeat] - START_STACK;
  sess.score.net += humanEV;
  if (humanEV > 1e-9) sess.score.wins += 1;
  else if (humanEV < -1e-9) sess.score.losses += 1;
  else sess.score.ties += 1;

  const result = {
    label: humanEV > 0 ? "You win" : humanEV < 0 ? "You lose" : "Tie",
    human_payoff: Number(humanEV.toFixed(2)),
    winner,
    terminal_type: wasFold ? "fold" : "showdown",
    final_stacks: finalStacks.map((v) => Number(v.toFixed(2))),
  };
  sess.resolved = true;
  sess.lastResult = result;
  return result;
}

function advanceStreet(sess) {
  sess.state.streetIdx += 1;
  sess.state.street = streets[sess.state.streetIdx];
  const idx = sess.state.streetIdx;
  if (idx === 1) sess.board = sess.fullBoard.slice(0, 3);
  else if (idx === 2) sess.board = sess.fullBoard.slice(0, 4);
  else if (idx === 3) sess.board = sess.fullBoard.slice(0, 5);
  enforceBoardInvariant(sess);
  sess.state.currentBet = 0;
  sess.state.commit = sess.state.commit.map(() => 0);
  sess.state.raises = 0;
  sess.state.consecutiveChecks = 0;
  sess.state.acted = [false, false];
  sess.state.toAct = 0; // HU: player 0 acts first postflop
}

function needsStreetAdvance(sess) {
  const eps = 1e-9;
  const evenCommit = Math.abs(sess.state.commit[0] - sess.state.commit[1]) <= eps &&
    Math.max(sess.state.currentBet - sess.state.commit[sess.state.toAct], 0) <= eps;
  const bothActed = sess.state.acted?.[0] && sess.state.acted?.[1];
  return evenCommit && bothActed;
}

function bettingClosedAllIn(sess) {
  const s0AllIn = sess.state.stack[0] <= 1e-9;
  const s1AllIn = sess.state.stack[1] <= 1e-9;
  if (!(s0AllIn || s1AllIn)) return false;
  const toCall0 = Math.max(0, sess.state.currentBet - sess.state.commit[0]);
  const toCall1 = Math.max(0, sess.state.currentBet - sess.state.commit[1]);
  return toCall0 <= 1e-9 && toCall1 <= 1e-9;
}

async function playToHuman(sess, actions) {
  while (!sess.state.terminal) {
    enforceBoardInvariant(sess);
    if (bettingClosedAllIn(sess)) {
      while (!sess.state.terminal && sess.state.streetIdx < 3) {
        advanceStreet(sess);
      }
      break;
    }
    if (needsStreetAdvance(sess) && sess.state.streetIdx < 3) {
      advanceStreet(sess);
      continue;
    }
    if (sess.state.toAct === sess.humanSeat) break;
    const action = botAct(sess, { seat: sess.state.toAct, apply: true });
    if (!action) break;
    actions.push(action);
  }
}

function botAct(sess, opts = {}) {
  const p = Number.isInteger(opts.seat) ? opts.seat : (1 - sess.humanSeat);
  const apply = opts.apply !== false;
  if (sess.state.toAct !== p || sess.state.terminal) return null;
  const toCall = Math.max(0, sess.state.currentBet - sess.state.commit[p]);
  const botHand = p === 0 ? sess.hero : sess.vill;
  const oppSeat = 1 - p;
  const oppRange = getRangeBelief(sess, oppSeat);
  const eqRes = evalStrength(botHand, sess.board, null, EQUITY_TRIALS);
  const hsRaw = eqRes.eq;
  let hs = conditionedEquity(hsRaw, oppRange);
  const extremeHs = hs <= 0.0001 || hs >= 0.9999;
  const nonRiver = sess.board.length < 5;
  if (extremeHs && nonRiver && eqRes.samples < 200) {
    warnDiag("eval_suspect_warnings", `EVAL_SUSPECT hs=${hs} raw=${hsRaw} samples=${eqRes.samples} board=${boardDesc(sess.board)} hero=${botHand}`);
  }
  let legal = legalActions(sess.state);
  legal = removeDominatedFold(legal, toCall, sess.state.pot, hs, 0.02);
  const spr = sprValue(sess.state, p);
  if (spr > 2 && hs < 0.7) legal = legal.filter((a) => a !== A.ALL_IN);
  if (spr > 10) legal = legal.filter((a) => a !== A.ALL_IN);
  if (hs < 0.6) legal = legal.filter((a) => a !== A.BET_POT && a !== A.RAISE_POT);

  const texture = boardTexture(sess.board);
  const oppProfile = sess.state.streetIdx > 0 ? getOpponentPostflopProfile(sess, sess.state.street) : null;
  if (sess.state.streetIdx > 0) {
    if (texture.paired && hs > 0.40 && hs < 0.70 && spr > 2) {
      legal = legal.filter((a) => a !== A.RAISE_HALF && a !== A.RAISE_POT && a !== A.BET_POT && a !== A.ALL_IN);
    }
    if (texture.dry) {
      legal = legal.filter((a) => a !== A.BET_POT && a !== A.RAISE_POT);
    }
    if (toCall > 1e-9 && hs >= 0.4 && hs <= 0.65 && spr > 2 && !texture.wet) {
      legal = legal.filter((a) => a !== A.RAISE_HALF && a !== A.RAISE_POT);
    } else if (hs >= 0.4 && hs <= 0.65 && spr > 3) {
      legal = legal.filter((a) => a !== A.RAISE_POT);
    }
    if (toCall <= 1e-9 && hs < 0.55 && spr > 4) {
      legal = legal.filter((a) => a !== A.BET_POT && a !== A.RAISE_POT);
    }
  }
  if (legal.length === 0) {
    warnDiag("illegal_state_warnings", `EMPTY_LEGAL_SET street=${sess.state.street} hs=${hs.toFixed(3)} spr=${spr.toFixed(2)}`);
    legal = legalActions(sess.state);
  }

  const evs = {};
  const evByAct = new Map();
  for (const act of legal) {
    const ev = estimateEV(sess.state, hs, act, texture, oppProfile, oppRange);
    evByAct.set(act, ev);
    evs[actionNames[act]] = Number(ev.toFixed(3));
  }

  let bestAct = legal[0];
  let priorKey = null;
  let priorHit = false;
  let priorBlendApplied = 0;
  let actionProbs = Array(actionNames.length).fill(0);
  let rtSubgame = null;
  const prior = sess.state.streetIdx > 0 ? getPostflopPriorProbs(sess.state, p, hs, texture) : null;
  priorKey = prior?.key || null;
  priorHit = Boolean(prior?.probs);

  const runRt = shouldRunRtSubgame(sess, p, spr);
  if (runRt) {
    const rt = solveRtSubgameDCFR({
      state: sess.state,
      legal,
      hs,
      texture,
      oppProfile,
      oppRangeBelief: oppRange,
      priorProbs: prior?.probs || null,
      thinkMs: RT_SUBGAME_MS,
      depthLimit: RT_SUBGAME_DEPTH,
    });
    if (rt?.probs) {
      ENGINE_DIAG.rt_subgame_hits += 1;
      rtSubgame = rt;
      actionProbs = rt.probs;
      const policyScores = new Map(legal.map((a) => [a, actionProbs[a] || 0]));
      bestAct = pickActionByEV(legal, policyScores, 0.000001) ?? legal[0];
    } else {
      ENGINE_DIAG.rt_subgame_fallbacks += 1;
    }
  }

  if (!rtSubgame) {
    let scoreMap = evByAct;
    if (sess.state.streetIdx > 0 && prior?.probs) {
      priorBlendApplied = Math.max(0, Math.min(1, BLUEPRINT_V1_EV_BLEND));
      scoreMap = blendEvWithPrior(legal, evByAct, prior.probs, priorBlendApplied);
    }
    bestAct = pickActionByEV(legal, scoreMap, sess.state.streetIdx > 0 ? 0.05 : 0.10) ?? legal[0];
    actionProbs = scoresToActionProbs(legal, scoreMap, sess.state.streetIdx > 0 ? 0.30 : 0.40);
  }

  let preflopTier = null;
  let oppThreeBetRate = null;
  let oppCallRate = null;
  let mixWeightsOut = null;
  if (sess.state.streetIdx === 0 && legal.length > 0) {
    const mix = buildPreflopMix(sess, botHand, legal, hs, toCall);
    bestAct = sampleActionWithMix(legal, evByAct, mix.weights);
    preflopTier = mix.tier;
    oppThreeBetRate = Number(mix.profile.threeBetRate.toFixed(3));
    oppCallRate = Number(mix.profile.callRate.toFixed(3));
    mixWeightsOut = Object.fromEntries(
      legal.map((a) => [actionNames[a], Number((mix.weights[a] || 0).toFixed(3))])
    );
    actionProbs = Array(actionNames.length).fill(0);
    for (const a of legal) actionProbs[a] = Number((mix.weights[a] || 0).toFixed(6));
  }

  if (sess.state.streetIdx > 0) {
    bestAct = applyConservativeOverride(sess.state, legal, bestAct, hs, texture, spr);
  }

  if (apply) {
    updateRangeBeliefFromAction(sess, p, bestAct, toCall);
    applyAction(sess.state, bestAct);
    if (sess.state.stack[0] <= 0 && sess.state.stack[1] <= 0) {
      while (!sess.state.terminal && sess.state.streetIdx < 3) {
        advanceStreet(sess);
      }
    }
  }

  return {
    seat: p,
    street: sess.state.street,
    action: {
      type: actionNames[bestAct],
      probs: actionProbs,
    },
    action_index: bestAct,
    pot: Number(sess.state.pot.toFixed(2)),
    to_call: Number(toCall.toFixed(2)),
    bucket_id: sess.state.streetIdx > 0 ? hsBand(hs) : null,
    bucket_source: sess.state.streetIdx > 0 ? "hs_band_v1" : "preflop",
    infoset_key: priorKey,
    hand_strength: Number(hs.toFixed(3)),
    hand_strength_raw: Number(hsRaw.toFixed(3)),
    board_class: sess.board.length ? boardDesc(sess.board) : "preflop",
    spr: spr === Infinity ? null : Number(spr.toFixed(2)),
    required_equity: sess.state.pot > 0 ? Number((toCall / (sess.state.pot + toCall || 1)).toFixed(3)) : 0,
    legal_after_guard: legal.map((a) => actionNames[a]),
    evs,
    samples: eqRes.samples,
    eval_error: eqRes.err || null,
    bot_hole_cards: botHand,
    opp_mode: "conditioned_range",
    range_belief: normalizeRangeBelief(oppRange),
    preflop_tier: preflopTier,
    opp_3bet_rate: oppThreeBetRate,
    opp_call_rate: oppCallRate,
    mix_weights: mixWeightsOut,
    board_texture: texture,
    opp_profile: oppProfile,
    prior_key: priorKey,
    prior_hit: priorHit,
    prior_blend: Number(priorBlendApplied.toFixed(3)),
    rt_subgame: rtSubgame
      ? {
          used: true,
          think_ms: RT_SUBGAME_MS,
          elapsed_ms: rtSubgame.elapsed_ms,
          iterations: rtSubgame.iterations,
          depth: RT_SUBGAME_DEPTH,
        }
      : {
          used: false,
          triggered: runRt,
          think_ms: RT_SUBGAME_MS,
          depth: RT_SUBGAME_DEPTH,
        },
  };
}

// Sessions
const sessions = new Map();

function buildPayload(sess, botActions = [], terminal = false, result = null) {
  const humanHand = sess.humanSeat === 0 ? sess.hero : sess.vill;
  const botSeat = 1 - sess.humanSeat;
  const botHand = botSeat === 0 ? sess.hero : sess.vill;
  const boardNow = terminal && sess.state.streetIdx >= 3 ? sess.fullBoard.slice(0, 5) : sess.board;
  const stackNow = terminal && Array.isArray(result?.final_stacks)
    ? result.final_stacks
    : sess.state.stack.map((x) => Number(x.toFixed(2)));
  const toCall = Math.max(0, sess.state.currentBet - sess.state.commit[sess.humanSeat]);
  const awaitingHuman = !terminal && sess.state.toAct === sess.humanSeat && !sess.state.terminal;
  const legalDetail = awaitingHuman
    ? legalActions(sess.state).map((a) => ({
        type: actionNames[a],
        size: Number(actionTarget(sess.state, a).toFixed(2)),
        index: a,
      }))
    : [];
  const stateSnapshot = {
    street: sess.state.street,
    pot: Number(sess.state.pot.toFixed(2)),
    to_call: Number(toCall.toFixed(2)),
    stacks: stackNow,
    action_history: sess.state.history.split(""),
    board: boardNow,
    board_desc: boardDesc(boardNow),
    your_hand: humanHand,
    bot_hand: terminal ? botHand : null,
  };
  return {
    ok: true,
    session_id: sess.id,
    hand_index: sess.handIndex,
    awaiting_human_action: awaitingHuman,
    legal_actions: legalDetail,
    bot_actions: botActions,
    state: stateSnapshot,
    showdown: terminal
      ? {
          human_hand: humanHand,
          bot_hand: botHand,
          board: boardNow,
          winner: result?.winner ?? sess.state.winner,
        }
      : null,
    terminal,
    result,
    score: sess.score,
  };
}

// Express app
const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    status: "fullgame-cpp-realtime",
    buckets: bucketCounts,
    enable_rt: ENABLE_RT,
    runtime_model: "cpp",
    blueprint_path: BLUEPRINT_PATH,
    blueprint_v1_path: BLUEPRINT_V1_PATH,
    enable_blueprint_v1_prior: ENABLE_BLUEPRINT_V1_PRIOR,
    equity_trials: EQUITY_TRIALS,
    postflop_prior: {
      enabled: postflopPrior.enabled,
      path: postflopPrior.path,
      ev_blend: BLUEPRINT_V1_EV_BLEND,
      prob_floor: BLUEPRINT_V1_PRIOR_PROB_FLOOR,
      infosets: postflopPrior.map.size,
      meta: postflopPrior.meta,
    },
    rt_subgame: {
      think_ms: RT_SUBGAME_MS,
      depth: RT_SUBGAME_DEPTH,
      trigger_pot: RT_TRIGGER_POT,
      trigger_spr: RT_TRIGGER_SPR,
      prior_weight: RT_PRIOR_WEIGHT,
    },
    action_abstraction: ACTION_ABSTRACTION,
  });
});

app.get("/api/diag", (_req, res) => {
  res.json({ ok: true, diag: ENGINE_DIAG });
});

app.post("/api/diag/reset", (_req, res) => {
  ENGINE_DIAG.board_invariant_warnings = 0;
  ENGINE_DIAG.eval_suspect_warnings = 0;
  ENGINE_DIAG.illegal_state_warnings = 0;
  ENGINE_DIAG.postflop_prior_hits = 0;
  ENGINE_DIAG.postflop_prior_misses = 0;
  ENGINE_DIAG.rt_subgame_hits = 0;
  ENGINE_DIAG.rt_subgame_fallbacks = 0;
  res.json({ ok: true, diag: ENGINE_DIAG });
});

app.post("/api/mirror_action", (req, res) => {
  const sess = sessions.get(req.body?.session_id);
  if (!sess) return res.status(400).json({ ok: false, error: "bad session" });
  if (sess.state.terminal) {
    return res.json({ ok: true, terminal: true, action_index: -1 });
  }
  const seat = Number.isInteger(req.body?.seat) ? Number(req.body.seat) : sess.state.toAct;
  const preview = botAct(sess, { seat, apply: false });
  if (!preview) return res.status(400).json({ ok: false, error: "cannot_preview_action" });
  const legal = legalActions(sess.state);
  const localIdx = legal.findIndex((a) => a === preview.action_index);
  if (localIdx < 0) return res.status(400).json({ ok: false, error: "preview_not_legal" });
  res.json({
    ok: true,
    action_index: localIdx,
    action_type: preview.action?.type || null,
    action_probs: preview.action?.probs || null,
    detail: preview,
  });
});

app.post("/api/new_game", (req, res) => {
  const humanSeat = Number(req.body?.human_seat ?? 0) === 1 ? 1 : 0;
  const id = crypto.randomUUID();
  const hand = newHand(humanSeat, 0);
  hand.id = id;
  hand.score = { wins: 0, losses: 0, ties: 0, net: 0 };
  ensureSessionStats(hand);
  sessions.set(id, hand);
  const actions = [];
  playToHuman(hand, actions)
    .then(() => res.json(buildPayload(hand, actions)))
    .catch((_e) => res.json(buildPayload(hand, actions)));
});

app.post("/api/new_hand", (req, res) => {
  const sess = sessions.get(req.body?.session_id);
  if (!sess) return res.status(400).json({ ok: false, error: "bad session" });
  const next = newHand(sess.humanSeat, sess.handIndex + 1);
  next.id = sess.id;
  next.score = sess.score;
  next.stats = ensureSessionStats(sess);
  sessions.set(sess.id, next);
  const actions = [];
  playToHuman(next, actions)
    .then(() => res.json(buildPayload(next, actions)))
    .catch((_e) => res.json(buildPayload(next, actions)));
});

app.post("/api/action", async (req, res) => {
  const sess = sessions.get(req.body?.session_id);
  if (!sess) return res.status(400).json({ ok: false, error: "bad session" });
  if (sess.state.terminal) {
    const result = sess.lastResult || settleTerminal(sess);
    return res.json(buildPayload(sess, [], true, result));
  }

  const idx = Number(req.body?.action_index);
  let legal = legalActions(sess.state);
  if (idx < 0 || idx >= legal.length) return res.status(400).json({ ok: false, error: "bad action index" });

  const humanAct = legal[idx];
  const toCallBefore = Math.max(0, sess.state.currentBet - sess.state.commit[sess.humanSeat]);
  const raisesBefore = sess.state.raises;
  const stats = ensureSessionStats(sess);
  if (sess.state.streetIdx === 0) {
    if (toCallBefore > 1e-9 && raisesBefore >= 1) {
      stats.human_facing_raise_preflop += 1;
      if (humanAct === A.CALL) stats.human_call_vs_raise_preflop += 1;
      if (humanAct === A.RAISE_HALF || humanAct === A.RAISE_POT || humanAct === A.ALL_IN) {
        stats.human_threebet_preflop += 1;
      }
    }
  } else {
    const street = sess.state.street;
    if (stats.postflop?.[street] && toCallBefore > 1e-9) {
      const st = stats.postflop[street];
      st.facing_bet += 1;
      if (humanAct === A.FOLD) st.fold_vs_bet += 1;
      else if (humanAct === A.CALL) st.call_vs_bet += 1;
      else if (humanAct === A.RAISE_HALF || humanAct === A.RAISE_POT || humanAct === A.ALL_IN) st.raise_vs_bet += 1;
    }
  }

  // apply human
  updateRangeBeliefFromAction(sess, sess.humanSeat, humanAct, toCallBefore);
  applyAction(sess.state, humanAct);

  const actions = [];
  await playToHuman(sess, actions);

  let result = null;
  const showdownReady =
    sess.state.streetIdx === 3 &&
    (needsStreetAdvance(sess) ||
      bettingClosedAllIn(sess) ||
      (sess.state.stack[0] <= 1e-9 && sess.state.stack[1] <= 1e-9));
  if (!sess.state.terminal && showdownReady) {
    sess.state.terminal = true;
  }
  if (sess.state.terminal) {
    result = settleTerminal(sess);
  }

  const terminal = sess.state.terminal;
  res.json(buildPayload(sess, actions, terminal, result));
});

app.listen(PORT, () => {
  console.log(`Fullgame bot API on ${PORT} (blueprint=${BLUEPRINT_PATH})`);
});
