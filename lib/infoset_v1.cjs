const streets = ["preflop", "flop", "turn", "river"];
const ranks = "23456789TJQKA";

function rankValue(card) {
  return ranks.indexOf(card[0]) + 2;
}

function suitCounts(board) {
  const counts = new Map();
  for (const card of board) {
    const suit = card[1];
    counts.set(suit, (counts.get(suit) || 0) + 1);
  }
  return counts;
}

function isPaired(board) {
  const seen = new Set();
  for (const card of board) {
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

function buildInfosetKey({ state, player, hs, spr = null, tex = null }) {
  const street = resolveStreet(state);
  const toCall = Math.max(0, (state?.currentBet || 0) - (state?.commit?.[player] || 0));
  const betState = toCall > 1e-9 ? "facingBet" : "unopened";
  const effectiveSpr = spr == null
    ? ((state?.pot || 0) > 0 ? (state?.stack?.[player] || 0) / Math.max(1, state.pot) : Infinity)
    : spr;
  const board = Array.isArray(state?.board) ? state.board : [];
  const textureValue = tex || texture(board);
  const raises = Math.max(0, Number(state?.raises || 0));
  return `${street}|${positionLabelHU(player)}|tex=${textureBits(textureValue)}|spr=${sprBand(effectiveSpr)}|${betState}|r=${raises}|hs=${hsBand(hs)}`;
}

module.exports = {
  texture,
  textureBits,
  sprBand,
  hsBand,
  buildInfosetKey,
};
