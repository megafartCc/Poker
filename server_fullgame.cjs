/**
 * Full-game Poker API (6-max capable, HU supported) with blinds and street progression.
 * Uses precomputed fullgame blueprint for action priors; falls back to simple pot-odds guard.
 * Note: This is a pragmatic bridge; it does not embed the native realtime solver yet,
 * but restores proper preflop/blinds/streets and uses bucket policies per street.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { solveRealtime } = require("./solver_bridge.cjs");

// Config
const PORT = Number(process.env.PORT || 8787);
const BUCKETS_PATH = process.env.BUCKETS_PATH || "C:/out/PokerBot/data/blueprint_buckets_v1_200.json";
const BLUEPRINT_PATH = process.env.BLUEPRINT_PATH || "C:/out/buckets/models/fullgame_v1/fullgame_blueprint.tsv";
const START_STACK = Number(process.env.START_STACK || 200);
const SMALL_BLIND = Number(process.env.SMALL_BLIND || 1);
const BIG_BLIND = Number(process.env.BIG_BLIND || 2);
const MAX_RAISES = Number(process.env.MAX_RAISES || 3);
const SEATS = Number(process.env.SEATS || 2); // allow HU for now

// Actions
const A = {
  FOLD: 0,
  CHECK: 1,
  CALL: 2,
  BET_HALF: 3,
  BET_POT: 4,
  RAISE_HALF: 5,
  RAISE_POT: 6,
  ALL_IN: 7,
};
const actionNames = ["FOLD", "CHECK", "CALL", "BET_HALF_POT", "BET_POT", "RAISE_HALF_POT", "RAISE_POT", "ALL_IN"];
const streets = ["preflop", "flop", "turn", "river"];

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

// Load blueprint (simple TSV: infoset ru1..r8)
function loadBlueprint(p) {
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
  const map = new Map();
  for (const line of lines) {
    if (!line || line.startsWith("infoset")) continue;
    const f = line.split("\t");
    if (f.length < 2 + 8) continue;
    const info = f[0];
    const probs = f.slice(2, 10).map((v) => Math.max(0, Number(v)));
    const s = probs.reduce((a, b) => a + b, 0);
    map.set(info, s > 1e-9 ? probs.map((v) => v / s) : probs.map(() => 1 / 8));
  }
  return map;
}
const blueprint = loadBlueprint(BLUEPRINT_PATH);

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

// Simplified equity surrogate per bucket (use bucket id / count)
function bucketEquity(bucket, street) {
  const k = bucketCounts[street] || 200;
  return (bucket + 0.5) / k; // crude; real equity needs card rollout
}

function legalActions(state) {
  if (state.terminal) return [];
  const p = state.toAct;
  const toCall = Math.max(0, state.currentBet - state.commit[p]);
  const stack = state.stack[p];
  const eps = 1e-9;
  const out = [];
  if (toCall <= eps) {
    out.push(A.CHECK);
    if (stack > eps) {
      out.push(A.BET_HALF, A.BET_POT, A.ALL_IN);
    }
    return out;
  }
  out.push(A.FOLD, A.CALL);
  if (stack > toCall + eps && state.raises < MAX_RAISES) {
    out.push(A.RAISE_HALF, A.RAISE_POT);
  }
  if (stack > toCall + eps) out.push(A.ALL_IN);
  return out;
}

function actionTarget(state, act) {
  const p = state.toAct;
  const toCall = Math.max(0, state.currentBet - state.commit[p]);
  switch (act) {
    case A.FOLD:
    case A.CHECK:
      return state.commit[p];
    case A.CALL:
      return state.commit[p] + Math.min(state.stack[p], toCall);
    case A.BET_HALF:
      return state.commit[p] + Math.min(state.stack[p], Math.max(1, state.pot * 0.5));
    case A.BET_POT:
      return state.commit[p] + Math.min(state.stack[p], Math.max(1, state.pot));
    case A.RAISE_HALF: {
      const desired = Math.max(toCall, Math.max(1, state.pot * 0.5));
      return state.currentBet + Math.min(state.stack[p], desired);
    }
    case A.RAISE_POT: {
      const desired = Math.max(toCall, Math.max(1, state.pot));
      return state.currentBet + Math.min(state.stack[p], desired);
    }
    case A.ALL_IN:
      return state.commit[p] + state.stack[p];
    default:
      return state.commit[p];
  }
}

function applyAction(state, act) {
  const p = state.toAct;
  const o = 1 - p;
  const toCall = Math.max(0, state.currentBet - state.commit[p]);
  const target = actionTarget(state, act);
  if (act === A.FOLD) {
    state.terminal = true;
    state.winner = o;
    state.history += "f";
    return;
  }
  if (act === A.CHECK) {
    state.history += "k";
    state.consecutiveChecks += 1;
    state.toAct = o;
    return;
  }
  // commit chips
  const pay = target - state.commit[p];
  const realPay = Math.min(pay, state.stack[p]);
  state.stack[p] -= realPay;
  state.commit[p] += realPay;
  state.pot += realPay;
  state.consecutiveChecks = 0;
  state.history += actionNames[act][0].toLowerCase();
  if (act === A.CALL || act === A.ALL_IN) {
    if (state.commit[p] > state.currentBet) {
      state.currentBet = state.commit[p];
      state.raises += 1;
    }
    state.toAct = o;
    return;
  }
  if (act === A.BET_HALF || act === A.BET_POT || act === A.RAISE_HALF || act === A.RAISE_POT) {
    state.currentBet = state.commit[p];
    state.raises += 1;
    state.toAct = o;
    return;
  }
}

function showdown(state, heroBucket, villBucket) {
  const e = heroBucket >= 0 ? bucketEquity(heroBucket, streets[state.streetIdx]) : 0.5;
  const c0 = state.commit[0];
  const pot = state.pot;
  const heroWin = pot - c0;
  const tie = 0.5 * pot - c0;
  const lose = -c0;
  return e * heroWin + (1 - e) * lose; // ignore ties for simplicity
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
    history: "",
    terminal: false,
    winner: -1,
    toAct: 0, // SB acts first preflop
  };
  return { humanSeat, handIndex, hero, vill, board: [], fullBoard, state };
}

function advanceStreet(sess) {
  sess.state.streetIdx += 1;
  sess.state.street = streets[sess.state.streetIdx];
  const idx = sess.state.streetIdx;
  if (idx === 1) sess.board = sess.fullBoard.slice(0, 3);
  else if (idx === 2) sess.board = sess.fullBoard.slice(0, 4);
  else if (idx === 3) sess.board = sess.fullBoard.slice(0, 5);
  sess.state.currentBet = 0;
  sess.state.commit = sess.state.commit.map(() => 0);
  sess.state.raises = 0;
  sess.state.consecutiveChecks = 0;
  sess.state.toAct = 0; // HU: player 0 acts first postflop
}

function needsStreetAdvance(sess) {
  const toCall = Math.max(0, sess.state.currentBet - sess.state.commit[sess.state.toAct]);
  const everyoneEven = toCall <= 1e-9 && sess.state.consecutiveChecks >= 1;
  return everyoneEven;
}

function botAct(sess) {
  const p = 1 - sess.humanSeat;
  const toCall = Math.max(0, sess.state.currentBet - sess.state.commit[p]);
  const equity = bucketEquity(p === 0 ? sampleBucket(sess.state.street) : sampleBucket(sess.state.street), sess.state.street);
  let legal = legalActions(sess.state);
  legal = removeDominatedFold(legal, toCall, sess.state.pot, equity);
  let chosen = legal[Math.floor(Math.random() * legal.length)];
  // light blueprint use: if flop/turn/river, query infoset
  if (sess.state.streetIdx > 0) {
    const infoset = `${sess.state.street}|p${p}|b0|pb0|cb0|sb0|r${sess.state.raises}|h${sess.state.history}`;
    const probs = blueprint.get(infoset);
    if (probs) {
      const weights = legal.map((a) => probs[a] || 0);
      const sum = weights.reduce((a, b) => a + b, 0);
      if (sum > 1e-9) {
        let r = Math.random() * sum;
        for (let i = 0; i < legal.length; i++) {
          r -= weights[i];
          if (r <= 0) { chosen = legal[i]; break; }
        }
      }
    }
  }
  applyAction(sess.state, chosen);
  return { seat: p, action: actionNames[chosen], pot: sess.state.pot, to_call: toCall };
}

// Sessions
const sessions = new Map();

function buildPayload(sess, botActions = [], terminal = false, result = null) {
  const toCall = Math.max(0, sess.state.currentBet - sess.state.commit[sess.humanSeat]);
  const awaitingHuman = !terminal && sess.state.toAct === sess.humanSeat && !sess.state.terminal;
  const legalDetail = awaitingHuman
    ? legalActions(sess.state).map((a) => ({
        type: actionNames[a],
        size: Number(actionTarget(sess.state, a).toFixed(2)),
        index: a,
      }))
    : [];
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
          street: sess.state.street,
          pot: Number(sess.state.pot.toFixed(2)),
          to_call: Number(toCall.toFixed(2)),
          stacks: sess.state.stack.map((x) => Number(x.toFixed(2))),
          action_history: sess.state.history.split(""),
          board: sess.board,
          your_hand: sess.hero,
        },
    terminal,
    result,
    score: sess.score,
  };
}

// Express app
const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, status: "fullgame-blueprint", buckets: bucketCounts });
});

app.post("/api/new_game", (req, res) => {
  const humanSeat = Number(req.body?.human_seat ?? 0) === 1 ? 1 : 0;
  const id = crypto.randomUUID();
  const hand = newHand(humanSeat, 0);
  hand.id = id;
  hand.score = { wins: 0, losses: 0, ties: 0, net: 0 };
  sessions.set(id, hand);
  res.json(buildPayload(hand));
});

app.post("/api/new_hand", (req, res) => {
  const sess = sessions.get(req.body?.session_id);
  if (!sess) return res.status(400).json({ ok: false, error: "bad session" });
  const next = newHand(sess.humanSeat, sess.handIndex + 1);
  next.id = sess.id;
  next.score = sess.score;
  sessions.set(sess.id, next);
  res.json(buildPayload(next));
});

app.post("/api/action", async (req, res) => {
  const sess = sessions.get(req.body?.session_id);
  if (!sess) return res.status(400).json({ ok: false, error: "bad session" });
  if (sess.state.terminal) return res.json(buildPayload(sess, [], true, null));

  const idx = Number(req.body?.action_index);
  let legal = legalActions(sess.state);
  if (idx < 0 || idx >= legal.length) return res.status(400).json({ ok: false, error: "bad action index" });

  // apply human
  applyAction(sess.state, legal[idx]);

  const actions = [];
  // bot acts until human turn or terminal or street change
  while (!sess.state.terminal && sess.state.toAct !== sess.humanSeat) {
    let botStep = null;
    if (sess.state.streetIdx > 0) {
      try {
        const rt = await solveRealtime({
          seats: sess.seats || 2,
          heroSeat: 1 - sess.humanSeat,
          street: sess.state.street,
          buckets: BUCKETS_PATH,
          blueprint: BLUEPRINT_PATH,
          thinkMs: Number(process.env.RT_MS || 800),
        });
        const legalBot = legalActions(sess.state);
        let chosen = legalBot[0];
        const name = (rt.chosen || "").toLowerCase();
        // crude mapping
        const preferred = {
          fold: A.FOLD,
          check: A.CHECK,
          call: A.CALL,
          bet: A.BET_HALF,
          raise: A.RAISE_HALF,
          all_in: A.ALL_IN,
        };
        if (preferred[name] !== undefined && legalBot.includes(preferred[name])) {
          chosen = preferred[name];
        }
        applyAction(sess.state, chosen);
        botStep = {
          seat: 1 - sess.humanSeat,
          street: sess.state.street,
          action: { type: actionNames[chosen], mix: rt.probs },
          pot: Number(sess.state.pot.toFixed(2)),
          to_call: Number(Math.max(0, sess.state.currentBet - sess.state.commit[sess.state.toAct]).toFixed(2)),
        };
      } catch (_err) {
        botStep = botAct(sess);
      }
    } else {
      botStep = botAct(sess);
    }
    actions.push(botStep);
    if (!sess.state.terminal && needsStreetAdvance(sess) && sess.state.streetIdx < 3) {
      advanceStreet(sess);
    }
    if (!sess.state.terminal && sess.state.toAct === sess.humanSeat) break;
    if (sess.state.terminal) break;
  }

  if (!sess.state.terminal && needsStreetAdvance(sess) && sess.state.streetIdx < 3) {
    advanceStreet(sess);
  }

  let result = null;
  if (!sess.state.terminal && sess.state.streetIdx === 3 && needsStreetAdvance(sess)) {
    // go to showdown
    sess.state.terminal = true;
    const ev = showdown(sess.state, sampleBucket("river"), sampleBucket("river"));
    const humanEV = sess.humanSeat === 0 ? ev : -ev;
    sess.score.net += humanEV;
    if (humanEV > 0) sess.score.wins += 1;
    else if (humanEV < 0) sess.score.losses += 1;
    else sess.score.ties += 1;
    result = { label: humanEV > 0 ? "You win" : humanEV < 0 ? "You lose" : "Tie", human_payoff: Number(humanEV.toFixed(2)) };
  }

  const terminal = sess.state.terminal;
  res.json(buildPayload(sess, actions, terminal, result));
});

app.listen(PORT, () => {
  console.log(`Fullgame bot API on ${PORT} (blueprint=${BLUEPRINT_PATH})`);
});
