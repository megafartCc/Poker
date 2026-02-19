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

function legalActions(state, maxRaises, _bigBlind) {
  if (state.terminal) return [];
  const p = state.toAct;
  const toCall = Math.max(0, state.currentBet - state.commit[p]);
  const stack = state.stack[p];
  const eps = 1e-9;
  const out = [];
  const unopened = toCall <= eps;
  const isPreflop = state.streetIdx === 0;

  if (unopened) {
    out.push(A.CHECK);
    if (stack > eps) {
      if (isPreflop) out.push(A.RAISE_HALF, A.RAISE_POT, A.ALL_IN);
      else out.push(A.BET_HALF, A.BET_POT, A.ALL_IN);
    }
    return out;
  }

  out.push(A.FOLD, A.CALL);
  if (stack > toCall + eps && state.raises < maxRaises) {
    out.push(A.RAISE_HALF, A.RAISE_POT);
  }
  if (stack > toCall + eps) out.push(A.ALL_IN);
  return out;
}

function actionTarget(state, act, bigBlind) {
  const p = state.toAct;
  const toCall = Math.max(0, state.currentBet - state.commit[p]);
  const isPreflop = state.streetIdx === 0;
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
      const desired = isPreflop
        ? Math.max(toCall * 2, bigBlind * 2)
        : Math.max(toCall, Math.max(1, state.pot * 0.5));
      return state.currentBet + Math.min(state.stack[p], desired);
    }
    case A.RAISE_POT: {
      const desired = isPreflop
        ? Math.max(toCall * 3, bigBlind * 3)
        : Math.max(toCall, Math.max(1, state.pot));
      return state.currentBet + Math.min(state.stack[p], desired);
    }
    case A.ALL_IN:
      return state.commit[p] + state.stack[p];
    default:
      return state.commit[p];
  }
}

module.exports = {
  A,
  actionNames,
  legalActions,
  actionTarget,
};
