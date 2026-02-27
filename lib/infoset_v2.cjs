const PokerEvaluator = require("poker-evaluator");

const streets = ["preflop", "flop", "turn", "river"];
const ranks = "23456789TJQKA";
const suitCanonAlphabet = ["a", "b", "c", "d"];

function rankValue(card) {
  return ranks.indexOf(card[0]) + 2;
}

function suitCounts(cards) {
  const counts = new Map();
  for (const card of cards || []) {
    const suit = card[1];
    counts.set(suit, (counts.get(suit) || 0) + 1);
  }
  return counts;
}

function isPaired(board) {
  const seen = new Set();
  for (const card of board || []) {
    const r = card[0];
    if (seen.has(r)) return true;
    seen.add(r);
  }
  return false;
}

function isMonotone(board) {
  if (!Array.isArray(board) || board.length < 3) return false;
  return suitCounts(board).size === 1;
}

function isTwoTone(board) {
  if (!Array.isArray(board) || board.length < 3) return false;
  return suitCounts(board).size === 2;
}

function isConnected(board) {
  if (!Array.isArray(board) || board.length < 3) return false;
  const values = [...new Set(board.map((card) => rankValue(card)))].sort((a, b) => a - b);
  if (values.length < 3) return false;
  let closePairs = 0;
  for (let i = 1; i < values.length; i++) {
    if ((values[i] - values[i - 1]) <= 2) closePairs += 1;
  }
  return closePairs >= 2;
}

function texture(board) {
  const paired = isPaired(board);
  const twoTone = isTwoTone(board);
  const monotone = isMonotone(board);
  const connected = isConnected(board);
  return { paired, twoTone, monotone, connected };
}

function textureBits(tex) {
  return `${tex.paired ? 1 : 0}${tex.twoTone ? 1 : 0}${tex.monotone ? 1 : 0}${tex.connected ? 1 : 0}`;
}

function sprBand(spr) {
  if (!Number.isFinite(spr)) return "8_plus";
  if (spr < 1) return "0_1";
  if (spr < 2) return "1_2";
  if (spr < 4) return "2_4";
  if (spr < 8) return "4_8";
  return "8_plus";
}

function hsBand(hs) {
  const clamped = Math.max(0, Math.min(0.999999, Number(hs) || 0));
  return Math.max(0, Math.min(9, Math.floor(clamped * 10)));
}

function positionLabelHU(player) {
  return player === 1 ? "IP" : "OOP";
}

function resolveStreet(state) {
  if (state?.street) return state.street;
  const idx = Number(state?.streetIdx || 0);
  return streets[idx] || "flop";
}

function canonicalizeSuits(cards) {
  const suitMap = new Map();
  let nextIdx = 0;
  const out = [];
  for (const card of cards || []) {
    const rank = card[0];
    const suit = card[1];
    if (!suitMap.has(suit)) {
      suitMap.set(suit, suitCanonAlphabet[nextIdx] || suitCanonAlphabet[suitMap.size % suitCanonAlphabet.length]);
      nextIdx += 1;
    }
    out.push(`${rank}${suitMap.get(suit)}`);
  }
  return out;
}

function boardRankPattern(board) {
  const vals = board.map((c) => rankValue(c));
  const uniq = [...new Set(vals)].sort((a, b) => a - b);
  const map = new Map();
  for (let i = 0; i < uniq.length; i++) map.set(uniq[i], i);
  return vals.map((v) => map.get(v)).join("");
}

function boardIsoToken(board) {
  const b = Array.isArray(board) ? board : [];
  if (!b.length) return "-";
  const canon = canonicalizeSuits(b);
  const suitPattern = canon.map((c) => c[1]).join("");
  const rankPattern = boardRankPattern(b);
  return `${b.length}${rankPattern}${suitPattern}`;
}

function compressHistory(history) {
  const h = String(history || "");
  if (!h.length) return "-";
  let out = "";
  let prev = h[0];
  let count = 1;
  for (let i = 1; i < h.length; i++) {
    const ch = h[i];
    if (ch === prev) {
      count += 1;
      continue;
    }
    out += prev + (count > 1 ? String(count) : "");
    prev = ch;
    count = 1;
  }
  out += prev + (count > 1 ? String(count) : "");
  return out;
}

function lineToken(history, maxChars = 4) {
  const h = String(history || "");
  if (!h.length) return "-";
  let mapped = "";
  for (const ch of h) {
    if (ch === "f") mapped += "F";
    else if (ch === "k" || ch === "c") mapped += "P";
    else mapped += "A";
  }
  if (mapped.length <= maxChars) return mapped;
  return mapped.slice(mapped.length - maxChars);
}

function handTypeClass(handType) {
  switch (handType) {
    case 1: return "hc";
    case 2: return "p1";
    case 3: return "p2";
    case 4: return "set";
    case 5: return "st";
    case 6: return "fl";
    case 7: return "fh";
    case 8: return "qu";
    case 9: return "sf";
    default: return "na";
  }
}

function straightDrawFlags(cards) {
  const vals = new Set();
  for (const c of cards) {
    const v = rankValue(c);
    vals.add(v);
    if (v === 14) vals.add(1);
  }
  let oesd = false;
  let gut = false;
  for (let start = 1; start <= 10; start++) {
    const need = [start, start + 1, start + 2, start + 3, start + 4];
    let have = 0;
    let miss = null;
    for (const n of need) {
      if (vals.has(n)) have += 1;
      else miss = n;
    }
    if (have === 4 && miss != null) {
      if (miss === start || miss === start + 4) oesd = true;
      else gut = true;
    }
  }
  return { oesd, gut };
}

function madeHandClass(heroHand, board) {
  if (!Array.isArray(heroHand) || heroHand.length !== 2) return "na";
  if (!Array.isArray(board) || board.length < 3) return "na";
  try {
    const evalRes = PokerEvaluator.evalHand([...heroHand, ...board]);
    return handTypeClass(evalRes?.handType);
  } catch (_err) {
    return "na";
  }
}

function drawClass(heroHand, board) {
  if (!Array.isArray(heroHand) || heroHand.length !== 2) return "na";
  if (!Array.isArray(board) || board.length < 3 || board.length >= 5) return "none";
  const cards = [...heroHand, ...board];
  const suitCount = suitCounts(cards);
  let maxSuit = 0;
  for (const v of suitCount.values()) maxSuit = Math.max(maxSuit, v);
  const made = madeHandClass(heroHand, board);
  const flushMade = made === "fl" || made === "fh" || made === "qu" || made === "sf";
  const flushDraw = !flushMade && maxSuit === 4;
  const straight = straightDrawFlags(cards);
  if (flushDraw && (straight.oesd || straight.gut)) return "combo";
  if (flushDraw) return "fd";
  if (straight.oesd) return "oesd";
  if (straight.gut) return "gut";
  return "none";
}

function buildInfosetKey({ state, player, hs, spr = null, tex = null, heroHand = null }) {
  const street = resolveStreet(state);
  const toCall = Math.max(0, (state?.currentBet || 0) - (state?.commit?.[player] || 0));
  const betState = toCall > 1e-9 ? "facingBet" : "unopened";
  const effectiveSpr = spr == null
    ? ((state?.pot || 0) > 0 ? (state?.stack?.[player] || 0) / Math.max(1, state.pot) : Infinity)
    : spr;
  const board = Array.isArray(state?.board) ? state.board : [];
  const textureValue = tex || texture(board);
  const raises = Math.max(0, Number(state?.raises || 0));
  const made = heroHand ? madeHandClass(heroHand, board) : "na";
  const draw = heroHand ? drawClass(heroHand, board) : "na";
  const iso = boardIsoToken(board);
  const line = lineToken(state?.history || "");
  return `${street}|${positionLabelHU(player)}|tex=${textureBits(textureValue)}|iso=${iso}|spr=${sprBand(effectiveSpr)}|${betState}|r=${raises}|line=${line}|made=${made}|draw=${draw}|hs=${hsBand(hs)}`;
}

module.exports = {
  texture,
  textureBits,
  sprBand,
  hsBand,
  boardIsoToken,
  lineToken,
  madeHandClass,
  drawClass,
  buildInfosetKey,
};
