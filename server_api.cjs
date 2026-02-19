/**
 * Minimal HTTP API that serves the MCCFR policies trained in PokerBot.
 * This mirrors the infoset keying / legal-action rules in src/mccfr.cpp
 * closely enough for flop/turn/river one-street play.
 *
 * Endpoints (JSON):
 *   GET  /api/health
 *   POST /api/new_game  { human_seat: 0|1 }
 *   POST /api/new_hand  { session_id }
 *   POST /api/action    { session_id, action_index }
 *   GET  /api/state?session_id=...
 */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---------- Config ----------
const PORT = Number(process.env.PORT || 8787);
const BUCKETS_PATH = process.env.BUCKETS_PATH || "C:/out/PokerBot/data/blueprint_buckets_v1_200.json";
const POLICY_FLOP = process.env.POLICY_FLOP || "C:/out/buckets/models/v1_2026-02-17/mccfr_flop.best.tsv";
const POLICY_TURN = process.env.POLICY_TURN || "C:/out/buckets/models/v1_2026-02-17/mccfr_turn.best.tsv";
const POLICY_RIVER = process.env.POLICY_RIVER || "C:/out/buckets/models/v1_2026-02-17/mccfr_river.best.tsv";
const MAX_RAISES = Number(process.env.MAX_RAISES || 2);

const kAction = {
  Fold: 0,
  Check: 1,
  Call: 2,
  BetHalfPot: 3,
  BetPot: 4,
  RaiseHalfPot: 5,
  RaisePot: 6,
  AllIn: 7,
};
const actionNames = [
  "FOLD",
  "CHECK",
  "CALL",
  "BET_HALF_POT",
  "BET_POT",
  "RAISE_HALF_POT",
  "RAISE_POT",
  "ALL_IN",
];
const actionSymbols = ["f", "k", "c", "b", "B", "r", "R", "a"];

// ---------- Loading utilities ----------
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadPolicy(p) {
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
  const map = new Map();
  for (const line of lines) {
    if (!line || line.startsWith("infoset")) continue;
    const fields = line.split("\t");
    if (fields.length < 2 + 8) continue;
    const infoset = fields[0];
    const probs = fields.slice(2, 10).map((v) => Math.max(0, Number(v)));
    const sum = probs.reduce((a, b) => a + b, 0);
    map.set(
      infoset,
      sum > 1e-9 ? probs.map((v) => v / sum) : probs.map(() => 1 / 8)
    );
  }
  return map;
}

function loadBucketCounts(bucketPath) {
  const j = readJson(bucketPath);
  const streets = j.streets || {};
  const out = {};
  ["flop", "turn", "river"].forEach((s) => {
    const centroids = streets[s]?.centroids || [];
    out[s] = centroids.length || 200;
  });
  return out;
}

const bucketCounts = loadBucketCounts(BUCKETS_PATH);
const policyMaps = {
  flop: loadPolicy(POLICY_FLOP),
  turn: loadPolicy(POLICY_TURN),
  river: loadPolicy(POLICY_RIVER),
};

// ---------- Game state helpers ----------
function randInt(n) {
  return Math.floor(Math.random() * n);
}
function sampleBucket(street) {
  const k = bucketCounts[street] || 200;
  return randInt(k);
}
function randomCard() {
  const ranks = "23456789TJQKA";
  const suits = "shdc";
  return (
    ranks[randInt(ranks.length)] + suits[randInt(suits.length)]
  );
}
function cardDeck(count) {
  const seen = new Set();
  const cards = [];
  while (cards.length < count) {
    const c = randomCard();
    if (!seen.has(c)) {
      seen.add(c);
      cards.push(c);
    }
  }
  return cards;
}

function boardTexture(board) {
  if (!board || board.length === 0) return "unknown";
  const ranks = board.map((c) => c[0]);
  const suits = board.map((c) => c[1]);
  const uniqueSuits = new Set(suits).size;
  const rankCounts = ranks.reduce((m, r) => {
    m[r] = (m[r] || 0) + 1;
    return m;
  }, {});
  const paired = Object.values(rankCounts).some((v) => v >= 2);
  const high = ranks.some((r) => ["A", "K", "Q"].includes(r.toUpperCase()));
  if (uniqueSuits === 1) return "monotone";
  if (uniqueSuits === 2) return "two-tone";
  if (paired && high) return "paired_high";
  if (paired) return "paired";
  if (high) return "high_rainbow";
  return "rainbow";
}

function discretizeRatio(numer, denom, scale, maxBucket) {
  const ratio = denom <= 1e-9 ? 0 : numer / denom;
  return Math.max(0, Math.min(maxBucket, Math.floor(ratio * scale + 1e-9)));
}

function infosetKey(state, street) {
  const player = state.playerToAct;
  const ownBucket = player === 0 ? state.bucket_p0 : state.bucket_p1;
  const toCall = Math.max(0, state.currentBet - state.committed[player]);
  const potBucket = discretizeRatio(state.pot, 25.0, 1.0, 80);
  const callBucket = discretizeRatio(toCall, Math.max(1.0, state.pot), 20.0, 80);
  const stackBucket = discretizeRatio(
    state.stack[player],
    Math.max(1.0, state.pot),
    10.0,
    80
  );
  return `${street}|p${player}|b${ownBucket}|pb${potBucket}|cb${callBucket}|sb${stackBucket}|r${state.raises}|h${state.history}`;
}

function betTargetTotal(state, player, frac) {
  return (
    state.committed[player] +
    Math.min(state.stack[player], Math.max(1.0, state.pot * frac))
  );
}
function raiseTargetTotal(state, player, frac) {
  const toCall = Math.max(0, state.currentBet - state.committed[player]);
  const freeAfterCall = Math.max(0, state.stack[player] - toCall);
  const desiredRaise = Math.max(toCall, Math.max(1.0, state.pot * frac));
  return state.currentBet + Math.min(freeAfterCall, desiredRaise);
}

function legalActions(state) {
  if (state.terminal) return [];
  const player = state.playerToAct;
  const toCall = Math.max(0, state.currentBet - state.committed[player]);
  const stack = state.stack[player];
  const seen = new Set();
  const actions = [];
  const add = (a) => {
    if (!seen.has(a)) {
      seen.add(a);
      actions.push(a);
    }
  };
  const eps = 1e-9;
  if (toCall <= eps) {
    add(kAction.Check);
    if (stack > eps) {
      if (betTargetTotal(state, player, 0.5) > state.committed[player] + eps) add(kAction.BetHalfPot);
      if (betTargetTotal(state, player, 1.0) > state.committed[player] + eps) add(kAction.BetPot);
      add(kAction.AllIn);
    }
    return actions;
  }
  add(kAction.Fold);
  add(kAction.Call);
  if (stack > toCall + eps && state.raises < MAX_RAISES) {
    if (raiseTargetTotal(state, player, 0.5) > state.currentBet + eps) add(kAction.RaiseHalfPot);
    if (raiseTargetTotal(state, player, 1.0) > state.currentBet + eps) add(kAction.RaisePot);
  }
  if (stack > toCall + eps) add(kAction.AllIn);
  return actions;
}

function actionTargetTotal(state, action) {
  const p = state.playerToAct;
  switch (action) {
    case kAction.Fold:
    case kAction.Check:
      return state.committed[p];
    case kAction.Call:
      return state.committed[p] + Math.min(state.stack[p], Math.max(0, state.currentBet - state.committed[p]));
    case kAction.BetHalfPot:
      return betTargetTotal(state, p, 0.5);
    case kAction.BetPot:
      return betTargetTotal(state, p, 1.0);
    case kAction.RaiseHalfPot:
      return raiseTargetTotal(state, p, 0.5);
    case kAction.RaisePot:
      return raiseTargetTotal(state, p, 1.0);
    case kAction.AllIn:
      return state.committed[p] + state.stack[p];
    default:
      return state.committed[p];
  }
}

function commitTo(state, player, target) {
  const needed = Math.max(0, target - state.committed[player]);
  const pay = Math.min(needed, state.stack[player]);
  state.stack[player] -= pay;
  state.committed[player] += pay;
  state.pot += pay;
}

function applyAction(state, action) {
  if (state.terminal) return state;
  const p = state.playerToAct;
  const o = 1 - p;
  const toCall = Math.max(0, state.currentBet - state.committed[p]);
  state.history += actionSymbols[action] || "?";
  const eps = 1e-9;

  switch (action) {
    case kAction.Fold:
      if (toCall <= eps) throw new Error("Fold illegal when check available");
      state.terminal = true;
      state.winner = o;
      return state;
    case kAction.Check:
      if (toCall > eps) throw new Error("Check illegal facing bet");
      state.consecutiveChecks += 1;
      if (state.consecutiveChecks >= 2) {
        state.terminal = true;
        state.winner = -1;
      } else {
        state.playerToAct = o;
      }
      return state;
    case kAction.Call: {
      if (toCall <= eps) throw new Error("Call illegal when to_call=0");
      const target = state.committed[p] + Math.min(state.stack[p], toCall);
      commitTo(state, p, target);
      state.consecutiveChecks = 0;
      state.terminal = true;
      state.winner = -1;
      return state;
    }
    case kAction.BetHalfPot:
    case kAction.BetPot: {
      if (toCall > eps) throw new Error("Bet illegal while facing bet");
      const frac = action === kAction.BetHalfPot ? 0.5 : 1.0;
      const target = betTargetTotal(state, p, frac);
      commitTo(state, p, target);
      if (state.committed[p] <= state.currentBet + eps) {
        state.terminal = true;
        state.winner = -1;
        return state;
      }
      state.currentBet = state.committed[p];
      state.raises += 1;
      state.consecutiveChecks = 0;
      state.playerToAct = o;
      return state;
    }
    case kAction.RaiseHalfPot:
    case kAction.RaisePot: {
      if (toCall <= eps) throw new Error("Raise illegal without facing bet");
      if (state.raises >= MAX_RAISES) throw new Error("Raise cap");
      const frac = action === kAction.RaiseHalfPot ? 0.5 : 1.0;
      const target = raiseTargetTotal(state, p, frac);
      commitTo(state, p, target);
      if (state.committed[p] <= state.currentBet + eps) {
        state.terminal = true;
        state.winner = -1;
        return state;
      }
      state.currentBet = state.committed[p];
      state.raises += 1;
      state.consecutiveChecks = 0;
      state.playerToAct = o;
      return state;
    }
    case kAction.AllIn: {
      const target = state.committed[p] + state.stack[p];
      commitTo(state, p, target);
      state.consecutiveChecks = 0;
      if (state.committed[p] > state.currentBet + eps) {
        state.currentBet = state.committed[p];
        state.raises += 1;
        state.playerToAct = o;
        return state;
      }
      state.terminal = true;
      state.winner = -1;
      return state;
    }
    default:
      throw new Error("Unknown action");
  }
}

function terminalUtility(state) {
  const c0 = state.committed[0];
  if (state.winner === 0) return state.pot - c0;
  if (state.winner === 1) return -c0;
  // showdown EV approx using bucket HS difference surrogate
  const diff = state.hs_p0 - state.hs_p1;
  const tie = 0.02 + 0.08 * Math.exp(-Math.abs(diff) * 10.0);
  let win = Math.min(1, Math.max(0, 0.5 + 1.2 * diff));
  win = Math.min(1 - tie, Math.max(0, win * (1 - tie)));
  const lose = 1 - tie - win;
  const winU = state.pot - c0;
  const tieU = 0.5 * state.pot - c0;
  const loseU = -c0;
  return win * winU + tie * tieU + lose * loseU;
}

function sampleActionFromPolicy(legal, infoset, policyMap) {
  if (!legal.length) throw new Error("no legal actions");
  const probs = policyMap.get(infoset);
  if (!probs) return legal[randInt(legal.length)];
  const weights = legal.map((a) => Math.max(0, probs[a]));
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 1e-9) return legal[randInt(legal.length)];
  let r = Math.random() * sum;
  for (let i = 0; i < legal.length; i++) {
    r -= weights[i];
    if (r <= 0) return legal[i];
  }
  return legal[legal.length - 1];
}

// ---------- Session handling ----------
const sessions = new Map();

function newState(street, humanSeat) {
  const bucket_p0 = sampleBucket(street);
  const bucket_p1 = sampleBucket(street);
  const start_pot = street === "flop" ? 90 + Math.random() * 40 : 100 + Math.random() * 60;
  const eff_stack = start_pot * 3;
  return {
    street,
    bucket_p0,
    bucket_p1,
    hs_p0: 0.5 + (Math.random() - 0.5) * 0.2,
    hs_p1: 0.5 + (Math.random() - 0.5) * 0.2,
    pot: start_pot,
    currentBet: 0,
    committed: [0, 0],
    stack: [eff_stack, eff_stack],
    raises: 0,
    consecutiveChecks: 0,
    terminal: false,
    winner: -1,
    history: "",
    playerToAct: humanSeat, // human acts first if chosen seat
  };
}

function makeSession(humanSeat) {
  const id = crypto.randomUUID();
  const street = "flop"; // single street UI
  const state = newState(street, humanSeat);
  const cards = cardDeck(2 + 3);
  const s = {
    id,
    humanSeat,
    street,
    handIndex: 0,
    score: { wins: 0, losses: 0, ties: 0, net: 0 },
    state,
    board: cards.slice(2),
    hero: cards.slice(0, 2),
  };
  sessions.set(id, s);
  return s;
}

function buildPayload(sess, botActions = [], terminal = false, result = null) {
  const awaitingHuman = !terminal && sess.state.playerToAct === sess.humanSeat && !sess.state.terminal;
  const legalDetail = awaitingHuman ? legalActions(sess.state).map((a) => ({
    type: actionNames[a],
    size: Number(actionTargetTotal(sess.state, a).toFixed(2)),
    index: a,
  })) : [];
  return {
    ok: true,
    session_id: sess.id,
    hand_index: sess.handIndex,
    awaiting_human_action: awaitingHuman,
    legal_actions: legalDetail,
    bot_actions: botActions,
    state: terminal
      ? null
      : {
          street: sess.street,
          pot: Number(sess.state.pot.toFixed(2)),
          to_call: Number(Math.max(0, sess.state.currentBet - sess.state.committed[sess.state.playerToAct]).toFixed(2)),
          stacks: sess.state.stack.map((x) => Number(x.toFixed(2))),
          action_history: sess.state.history.split("").map((ch) => ch),
          board: sess.board,
          your_hand: sess.hero,
        },
    terminal,
    result,
    score: sess.score,
  };
}

function dealNewHand(sess) {
  sess.handIndex += 1;
  sess.state = newState(sess.street, sess.humanSeat);
  const cards = cardDeck(5);
  sess.hero = cards.slice(0, 2);
  sess.board = cards.slice(2);
  return buildPayload(sess, [], false, null);
}

function botPlay(sess) {
  const s = sess.state;
  const policy = policyMaps[sess.street];
  const botSeat = 1 - sess.humanSeat;
  const actions = [];
  while (!s.terminal && s.playerToAct !== sess.humanSeat) {
    const legal = legalActions(s);
    const infoset = infosetKey(s, sess.street);
    const act = sampleActionFromPolicy(legal, infoset, policy);
    actions.push({
      seat: botSeat,
      street: sess.street,
      bucket_id: botSeat === 0 ? s.bucket_p0 : s.bucket_p1,
      hand_strength: botSeat === 0 ? s.hs_p0 : s.hs_p1,
      board_class: boardTexture(sess.board),
      pot: Number(s.pot.toFixed(2)),
      to_call: Number(Math.max(0, s.currentBet - s.committed[s.playerToAct]).toFixed(2)),
      spr: Number((s.stack[s.playerToAct] / Math.max(1e-6, s.pot)).toFixed(2)),
      action: { type: actionNames[act] },
    });
    applyAction(s, act);
  }
  let result = null;
  let terminal = s.terminal;
  if (terminal) {
    const util0 = terminalUtility(s);
    const human_ev = sess.humanSeat === 0 ? util0 : -util0;
    if (human_ev > 0) sess.score.wins += 1;
    else if (human_ev < 0) sess.score.losses += 1;
    else sess.score.ties += 1;
    sess.score.net += human_ev;
    result = {
      label: human_ev > 0 ? "You win" : human_ev < 0 ? "You lose" : "Tie",
      human_payoff: Number(human_ev.toFixed(2)),
    };
  }
  return { payload: buildPayload(sess, actions, terminal, result), terminal };
}

// ---------- HTTP server ----------
const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, status: "mccfr-policy", buckets: bucketCounts });
});

app.get("/api/state", (req, res) => {
  const id = req.query.session_id;
  const sess = sessions.get(id);
  if (!sess) return res.status(400).json({ ok: false, error: "bad session" });
  res.json(buildPayload(sess));
});

app.post("/api/new_game", (req, res) => {
  const humanSeat = Number(req.body?.human_seat ?? 0) === 1 ? 1 : 0;
  const sess = makeSession(humanSeat);
  const payload = dealNewHand(sess);
  res.json(payload);
});

app.post("/api/new_hand", (req, res) => {
  const sess = sessions.get(req.body?.session_id);
  if (!sess) return res.status(400).json({ ok: false, error: "bad session" });
  const payload = dealNewHand(sess);
  res.json(payload);
});

app.post("/api/action", (req, res) => {
  const sess = sessions.get(req.body?.session_id);
  if (!sess) return res.status(400).json({ ok: false, error: "bad session" });
  const idx = Number(req.body?.action_index);
  const legal = legalActions(sess.state);
  if (idx < 0 || idx >= legal.length) {
    return res.status(400).json({ ok: false, error: "bad action index" });
  }
  // apply human action
  applyAction(sess.state, legal[idx]);
  if (sess.state.terminal) {
    const util0 = terminalUtility(sess.state);
    const human_ev = sess.humanSeat === 0 ? util0 : -util0;
    if (human_ev > 0) sess.score.wins += 1;
    else if (human_ev < 0) sess.score.losses += 1;
    else sess.score.ties += 1;
    sess.score.net += human_ev;
    const result = {
      label: human_ev > 0 ? "You win" : human_ev < 0 ? "You lose" : "Tie",
      human_payoff: Number(human_ev.toFixed(2)),
    };
    return res.json(buildPayload(sess, [], true, result));
  }
  // bot acts (possibly multiple until human turn or terminal)
  const { payload } = botPlay(sess);
  res.json(payload);
});

app.listen(PORT, () => {
  console.log(`Bot API using MCCFR policies on port ${PORT}`);
  console.log(`Buckets: ${BUCKETS_PATH}`);
  console.log(`Policies: flop=${POLICY_FLOP} turn=${POLICY_TURN} river=${POLICY_RIVER}`);
});
