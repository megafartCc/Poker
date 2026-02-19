const BASE = process.env.API_BASE || "http://127.0.0.1:8787";
const HANDS = Number(process.argv[2] || 1000);
const PROFILE = String(process.env.OPP_PROFILE || process.argv[3] || "balanced").toLowerCase();
const HUMAN_SEAT = Number(process.env.HUMAN_SEAT || 0);

function isMirrorProfile() {
  return PROFILE === "mirror" || PROFILE === "balanced_mirror" || PROFILE === "mirror_bot";
}

async function api(path, method = "GET", body = null) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data?.ok === false) {
    throw new Error(`API ${method} ${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

function chooseHumanActionBalanced(payload, idxByType, toCall, pot) {
  if (toCall <= 1e-9) {
    if (idxByType.CHECK != null && Math.random() < 0.82) return idxByType.CHECK;
    if (idxByType.BET_HALF_POT != null && Math.random() < 0.65) return idxByType.BET_HALF_POT;
    if (idxByType.RAISE_HALF_POT != null && Math.random() < 0.65) return idxByType.RAISE_HALF_POT;
    if (idxByType.BET_POT != null && Math.random() < 0.12) return idxByType.BET_POT;
    if (idxByType.RAISE_POT != null && Math.random() < 0.12) return idxByType.RAISE_POT;
    if (idxByType.ALL_IN != null && Math.random() < 0.01) return idxByType.ALL_IN;
    return 0;
  }

  const reqEq = toCall / Math.max(1, pot + toCall);
  const foldBias = Math.max(0.12, Math.min(0.62, reqEq + 0.18));
  if (idxByType.FOLD != null && Math.random() < foldBias) return idxByType.FOLD;
  if (idxByType.CALL != null && Math.random() < 0.80) return idxByType.CALL;
  if (idxByType.RAISE_HALF_POT != null && Math.random() < 0.14) return idxByType.RAISE_HALF_POT;
  if (idxByType.RAISE_POT != null && Math.random() < 0.06) return idxByType.RAISE_POT;
  if (idxByType.ALL_IN != null && Math.random() < 0.03) return idxByType.ALL_IN;
  if (idxByType.CALL != null) return idxByType.CALL;
  if (idxByType.FOLD != null) return idxByType.FOLD;
  return 0;
}

function chooseHumanActionNit(idxByType, toCall, pot) {
  if (toCall <= 1e-9) {
    if (idxByType.CHECK != null && Math.random() < 0.93) return idxByType.CHECK;
    if (idxByType.BET_HALF_POT != null && Math.random() < 0.06) return idxByType.BET_HALF_POT;
    if (idxByType.BET_POT != null && Math.random() < 0.01) return idxByType.BET_POT;
    return idxByType.CHECK ?? 0;
  }
  const reqEq = toCall / Math.max(1, pot + toCall);
  const foldP = Math.max(0.55, Math.min(0.92, 0.58 + reqEq * 0.8));
  if (idxByType.FOLD != null && Math.random() < foldP) return idxByType.FOLD;
  if (idxByType.CALL != null && Math.random() < 0.92) return idxByType.CALL;
  if (idxByType.RAISE_HALF_POT != null && Math.random() < 0.03) return idxByType.RAISE_HALF_POT;
  return idxByType.CALL ?? idxByType.FOLD ?? 0;
}

function chooseHumanActionStation(idxByType, toCall) {
  if (toCall <= 1e-9) {
    if (idxByType.CHECK != null && Math.random() < 0.66) return idxByType.CHECK;
    if (idxByType.BET_HALF_POT != null && Math.random() < 0.28) return idxByType.BET_HALF_POT;
    if (idxByType.BET_POT != null && Math.random() < 0.06) return idxByType.BET_POT;
    return idxByType.CHECK ?? 0;
  }
  if (idxByType.CALL != null && Math.random() < 0.90) return idxByType.CALL;
  if (idxByType.FOLD != null && Math.random() < 0.08) return idxByType.FOLD;
  if (idxByType.RAISE_HALF_POT != null && Math.random() < 0.02) return idxByType.RAISE_HALF_POT;
  return idxByType.CALL ?? idxByType.FOLD ?? 0;
}

function chooseHumanActionAggro(idxByType, toCall, pot) {
  if (toCall <= 1e-9) {
    if (idxByType.BET_HALF_POT != null && Math.random() < 0.55) return idxByType.BET_HALF_POT;
    if (idxByType.BET_POT != null && Math.random() < 0.25) return idxByType.BET_POT;
    if (idxByType.ALL_IN != null && Math.random() < 0.03) return idxByType.ALL_IN;
    if (idxByType.CHECK != null) return idxByType.CHECK;
    return 0;
  }
  const reqEq = toCall / Math.max(1, pot + toCall);
  if (idxByType.RAISE_HALF_POT != null && Math.random() < Math.max(0.18, 0.42 - reqEq * 0.5)) return idxByType.RAISE_HALF_POT;
  if (idxByType.RAISE_POT != null && Math.random() < Math.max(0.08, 0.22 - reqEq * 0.35)) return idxByType.RAISE_POT;
  if (idxByType.CALL != null && Math.random() < 0.72) return idxByType.CALL;
  if (idxByType.FOLD != null) return idxByType.FOLD;
  return idxByType.CALL ?? 0;
}

function chooseHumanActionPotOdds(idxByType, toCall, pot) {
  if (toCall <= 1e-9) {
    if (idxByType.CHECK != null && Math.random() < 0.84) return idxByType.CHECK;
    if (idxByType.BET_HALF_POT != null && Math.random() < 0.15) return idxByType.BET_HALF_POT;
    return idxByType.CHECK ?? 0;
  }
  const reqEq = toCall / Math.max(1, pot + toCall);
  if (reqEq <= 0.33) {
    if (idxByType.RAISE_HALF_POT != null && reqEq < 0.16 && Math.random() < 0.10) return idxByType.RAISE_HALF_POT;
    if (idxByType.CALL != null) return idxByType.CALL;
  }
  if (idxByType.FOLD != null) return idxByType.FOLD;
  return idxByType.CALL ?? 0;
}

function chooseHumanAction(payload) {
  const legal = payload.legal_actions || [];
  const state = payload.state || {};
  const toCall = Number(state.to_call || 0);
  const pot = Number(state.pot || 0);

  const idxByType = {};
  legal.forEach((a, i) => { idxByType[a.type] = i; });

  if (PROFILE === "nit") return chooseHumanActionNit(idxByType, toCall, pot);
  if (PROFILE === "station") return chooseHumanActionStation(idxByType, toCall);
  if (PROFILE === "aggro") return chooseHumanActionAggro(idxByType, toCall, pot);
  if (PROFILE === "pot_odds" || PROFILE === "potodds") return chooseHumanActionPotOdds(idxByType, toCall, pot);
  if (PROFILE === "balanced_mirror" || PROFILE === "mirror" || PROFILE === "mirror_bot") {
    return chooseHumanActionBalanced(payload, idxByType, toCall, pot);
  }
  return chooseHumanActionBalanced(payload, idxByType, toCall, pot);
}

function isPostflopStreet(street) {
  return street === "flop" || street === "turn" || street === "river";
}

function isBluffAttempt(actionType, hs, street) {
  if (!isPostflopStreet(street)) return false;
  if (hs == null || !Number.isFinite(Number(hs))) return false;
  if (!isAggressive(actionType) && actionType !== "ALL_IN") return false;
  return Number(hs) <= 0.45;
}

function makeHandContext() {
  return {
    pendingBluffPressure: false,
  };
}

function registerFacingBetMetrics(metrics, payload, chosenType) {
  const toCall = Number(payload?.state?.to_call || 0);
  const street = payload?.state?.street || "";
  if (toCall <= 1e-9) return;
  if (street === "flop") {
    metrics.facing_flop_bet += 1;
    if (chosenType === "FOLD") metrics.fold_vs_flop_bet += 1;
  } else if (street === "turn") {
    metrics.facing_turn_bet += 1;
    if (chosenType === "FOLD") metrics.fold_vs_turn_bet += 1;
  }
}

function isAggressive(type) {
  return type === "BET_HALF_POT" || type === "BET_POT" || type === "RAISE_HALF_POT" || type === "RAISE_POT";
}

function makeStreetStats() {
  return {
    actions: 0,
    raises: 0,
    allins: 0,
  };
}

async function main() {
  const metrics = {
    hands: HANDS,
    profile: PROFILE,
    human_seat: HUMAN_SEAT,
    bot_actions: 0,
    hs_extreme_count: 0,
    illegal_call_to_zero: 0,
    illegal_preflop_bet_label: 0,
    stalled_hands: 0,
    allin_after_stack_zero_actions: 0,
    human_wins: 0,
    bot_wins: 0,
    ties: 0,
    human_net: 0,
    bot_net: 0,
    hands_with_payoff: 0,
    showdown_hands: 0,
    showdown_human_wins: 0,
    showdown_bot_wins: 0,
    showdown_ties: 0,
    facing_flop_bet: 0,
    fold_vs_flop_bet: 0,
    facing_turn_bet: 0,
    fold_vs_turn_bet: 0,
    bluff_attempts: 0,
    bluff_successes: 0,
    fold_to_raise_opportunities: 0,
    fold_to_raise_taken: 0,
    by_street: {
      preflop: makeStreetStats(),
      flop: makeStreetStats(),
      turn: makeStreetStats(),
      river: makeStreetStats(),
    },
  };

  await api("/api/diag/reset", "POST", {});
  let payload = await api("/api/new_game", "POST", { human_seat: HUMAN_SEAT, seats: 2 });
  const sessionId = payload.session_id;

  function ingestBotActions(botActions, handCtx) {
    for (const ba of botActions || []) {
      const type = ba?.action?.type || "";
      const street = ba?.street || "preflop";
      if (!metrics.by_street[street]) metrics.by_street[street] = makeStreetStats();
      metrics.by_street[street].actions += 1;
      metrics.bot_actions += 1;
      if (isAggressive(type)) metrics.by_street[street].raises += 1;
      if (type === "ALL_IN") metrics.by_street[street].allins += 1;
      if (ba?.hand_strength === 0 || ba?.hand_strength === 1) metrics.hs_extreme_count += 1;
      if (type === "CALL" && Number(ba?.to_call || 0) <= 1e-9) metrics.illegal_call_to_zero += 1;
      if (street === "preflop" && (type === "BET_HALF_POT" || type === "BET_POT")) {
        metrics.illegal_preflop_bet_label += 1;
      }
      if ((Number(ba?.spr ?? 1) <= 0) && street !== "river" && (type === "BET_HALF_POT" || type === "BET_POT" || type === "RAISE_HALF_POT" || type === "RAISE_POT")) {
        metrics.allin_after_stack_zero_actions += 1;
      }
      if (isBluffAttempt(type, ba?.hand_strength, street)) {
        metrics.bluff_attempts += 1;
        handCtx.pendingBluffPressure = true;
      }
    }
  }

  for (let h = 1; h <= HANDS; h++) {
    const handCtx = makeHandContext();
    ingestBotActions(payload.bot_actions, handCtx);

    let guard = 0;
    while (!payload.terminal && guard < 64) {
      guard += 1;
      if (!payload.awaiting_human_action || !Array.isArray(payload.legal_actions) || payload.legal_actions.length === 0) {
        metrics.stalled_hands += 1;
        break;
      }
      let idx = chooseHumanAction(payload);
      if (isMirrorProfile()) {
        try {
          const mirror = await api("/api/mirror_action", "POST", { session_id: sessionId, seat: HUMAN_SEAT });
          if (Number.isInteger(mirror?.action_index)) idx = mirror.action_index;
        } catch (_err) {
          // keep local fallback action
        }
      }
      if (!Number.isInteger(idx) || idx < 0 || idx >= payload.legal_actions.length) idx = 0;
      const chosen = payload.legal_actions[idx] || payload.legal_actions[0];
      registerFacingBetMetrics(metrics, payload, chosen?.type);
      const toCall = Number(payload?.state?.to_call || 0);
      if (handCtx.pendingBluffPressure && toCall <= 1e-9) {
        handCtx.pendingBluffPressure = false;
      }
      if (handCtx.pendingBluffPressure && toCall > 1e-9) {
        if (chosen?.type === "FOLD") metrics.bluff_successes += 1;
        handCtx.pendingBluffPressure = false;
      }
      if (toCall > 1e-9 && chosen) {
        metrics.fold_to_raise_opportunities += 1;
        if (chosen.type === "FOLD") metrics.fold_to_raise_taken += 1;
      }
      payload = await api("/api/action", "POST", { session_id: sessionId, action_index: idx });
      ingestBotActions(payload.bot_actions, handCtx);
    }

    const payoff = Number(payload?.result?.human_payoff ?? 0);
    metrics.human_net += payoff;
    metrics.bot_net -= payoff;
    metrics.hands_with_payoff += 1;
    if (payoff > 0) metrics.human_wins += 1;
    else if (payoff < 0) metrics.bot_wins += 1;
    else metrics.ties += 1;

    const terminalType = payload?.result?.terminal_type || "";
    if (terminalType === "showdown") {
      metrics.showdown_hands += 1;
      if (payoff > 0) metrics.showdown_human_wins += 1;
      else if (payoff < 0) metrics.showdown_bot_wins += 1;
      else metrics.showdown_ties += 1;
    }
    if (h < HANDS) {
      payload = await api("/api/new_hand", "POST", { session_id: sessionId });
    }
  }

  const diag = await api("/api/diag", "GET");

  const summary = {
    ...metrics,
    fold_to_raise_pct: metrics.fold_to_raise_opportunities > 0
      ? Number((metrics.fold_to_raise_taken / metrics.fold_to_raise_opportunities).toFixed(4))
      : 0,
    allin_freq: metrics.bot_actions > 0
      ? Number(((metrics.by_street.preflop.allins + metrics.by_street.flop.allins + metrics.by_street.turn.allins + metrics.by_street.river.allins) / metrics.bot_actions).toFixed(4))
      : 0,
    human_ev_per_hand: metrics.hands_with_payoff > 0 ? Number((metrics.human_net / metrics.hands_with_payoff).toFixed(4)) : 0,
    bot_ev_per_hand: metrics.hands_with_payoff > 0 ? Number((metrics.bot_net / metrics.hands_with_payoff).toFixed(4)) : 0,
    showdown_bot_win_pct: metrics.showdown_hands > 0
      ? Number((metrics.showdown_bot_wins / metrics.showdown_hands).toFixed(4))
      : 0,
    showdown_rate: metrics.hands > 0 ? Number((metrics.showdown_hands / metrics.hands).toFixed(4)) : 0,
    fold_vs_flop_bet_pct: metrics.facing_flop_bet > 0 ? Number((metrics.fold_vs_flop_bet / metrics.facing_flop_bet).toFixed(4)) : 0,
    fold_vs_turn_bet_pct: metrics.facing_turn_bet > 0 ? Number((metrics.fold_vs_turn_bet / metrics.facing_turn_bet).toFixed(4)) : 0,
    bluff_success_rate: metrics.bluff_attempts > 0 ? Number((metrics.bluff_successes / metrics.bluff_attempts).toFixed(4)) : 0,
    raise_freq_by_street: {
      preflop: metrics.by_street.preflop.actions ? Number((metrics.by_street.preflop.raises / metrics.by_street.preflop.actions).toFixed(4)) : 0,
      flop: metrics.by_street.flop.actions ? Number((metrics.by_street.flop.raises / metrics.by_street.flop.actions).toFixed(4)) : 0,
      turn: metrics.by_street.turn.actions ? Number((metrics.by_street.turn.raises / metrics.by_street.turn.actions).toFixed(4)) : 0,
      river: metrics.by_street.river.actions ? Number((metrics.by_street.river.raises / metrics.by_street.river.actions).toFixed(4)) : 0,
    },
    diag: diag.diag,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
