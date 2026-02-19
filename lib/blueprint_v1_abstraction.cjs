const ranks = "23456789TJQKA";

function rankValue(card) {
  return ranks.indexOf(card[0]) + 2;
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
  const rr = boardRanksArray(board);
  return new Set(rr).size < rr.length;
}

function isMonotone(board) {
  if (board.length < 3) return false;
  return Object.keys(boardSuitCounts(board)).length === 1;
}

function isConnected(board) {
  if (board.length < 3) return false;
  const vals = [...new Set(board.map((c) => rankValue(c)))].sort((a, b) => a - b);
  if (vals.length < 3) return false;
  let closePairs = 0;
  for (let i = 1; i < vals.length; i++) {
    if ((vals[i] - vals[i - 1]) <= 2) closePairs += 1;
  }
  return closePairs >= 2;
}

function boardTexture(board) {
  const suitsCount = Object.keys(boardSuitCounts(board)).length;
  const paired = isPaired(board);
  const monotone = isMonotone(board);
  const connected = isConnected(board);
  const twoTone = board.length >= 3 && suitsCount === 2;
  const wet = monotone || twoTone || connected;
  const dry = !wet && !paired;
  return { paired, twoTone, monotone, connected, wet, dry };
}

function sprBandFromValue(spr) {
  if (!Number.isFinite(spr)) return "8_plus";
  if (spr < 1) return "0_1";
  if (spr < 2) return "1_2";
  if (spr < 4) return "2_4";
  if (spr < 8) return "4_8";
  return "8_plus";
}

function hsBandFromValue(hs) {
  return Math.max(0, Math.min(9, Math.floor(Math.max(0, Math.min(0.999999, hs)) * 10)));
}

function textureBits(texture) {
  return `${texture?.paired ? 1 : 0}${texture?.twoTone ? 1 : 0}${texture?.monotone ? 1 : 0}${texture?.connected ? 1 : 0}`;
}

function positionLabel(seats, player) {
  if (seats === 2) return player === 1 ? "IP" : "OOP";
  return `P${player}`;
}

function buildBlueprintV1InfosetKey({ state, player, hs, spr, texture, seats = 2 }) {
  const street = state.street;
  const toCall = Math.max(0, state.currentBet - state.commit[player]);
  const betState = toCall > 1e-9 ? "facingBet" : "unopened";
  const sprBand = sprBandFromValue(spr);
  const bits = textureBits(texture);
  const hsBand = hsBandFromValue(hs);
  const raises = Math.max(0, Math.min(99, state.raises || 0));
  return `${street}|${positionLabel(seats, player)}|tex=${bits}|spr=${sprBand}|${betState}|r=${raises}|hs=${hsBand}`;
}

module.exports = {
  rankValue,
  boardTexture,
  sprBandFromValue,
  hsBandFromValue,
  textureBits,
  buildBlueprintV1InfosetKey,
};
