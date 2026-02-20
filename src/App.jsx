import { useCallback, useEffect, useMemo, useState } from "react";
import * as cardDeck from "@letele/playing-cards/dist/index.esm.js";

const ACTION_TYPES = {
  FOLD: "FOLD",
  CHECK: "CHECK",
  CALL: "CALL",
  BET_HALF_POT: "BET_HALF_POT",
  BET_POT: "BET_POT",
  RAISE_HALF_POT: "RAISE_HALF_POT",
  RAISE_POT: "RAISE_POT",
  ALL_IN: "ALL_IN",
};

const defaultSession = {
  session_id: "",
  hand_index: 0,
  awaiting_human_action: false,
  legal_actions: [],
  bot_actions: [],
  state: null,
  showdown: null,
  terminal: false,
  result: null,
  score: { wins: 0, losses: 0, ties: 0, net: 0 },
};

function formatMoney(v) {
  if (v == null || Number.isNaN(Number(v))) return "-";
  return Number(v).toFixed(2);
}

function toDeckKey(card) {
  if (!card || String(card).length < 2) return null;
  const rankRaw = String(card[0] || "").toUpperCase();
  const suitRaw = String(card[1] || "").toLowerCase();
  const rankMap = {
    A: "a",
    K: "k",
    Q: "q",
    J: "j",
    T: "10",
    "9": "9",
    "8": "8",
    "7": "7",
    "6": "6",
    "5": "5",
    "4": "4",
    "3": "3",
    "2": "2",
  };
  const suitMap = { s: "S", h: "H", d: "D", c: "C" };
  const rank = rankMap[rankRaw];
  const suit = suitMap[suitRaw];
  if (!rank || !suit) return null;
  return `${suit}${rank}`;
}

function useApi() {
  const request = useCallback(async (path, options = {}) => {
    const res = await fetch(path, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      const msg = data?.error || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }, []);
  return { request };
}

function PlayingCard({ card, hidden = false, delayMs = 0, reveal = false }) {
  const key = hidden ? "B1" : toDeckKey(card);
  const CardSvg = cardDeck[key] || cardDeck.B1;
  const classes = ["playing-card"];
  if (reveal) classes.push("reveal");
  if (!card && !hidden) classes.push("is-placeholder");
  return (
    <div
      className={classes.join(" ")}
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <CardSvg className="playing-card-svg" style={{ width: "100%", height: "100%" }} />
    </div>
  );
}

function ResultBanner({ result, onClose }) {
  if (!result) return null;
  const win = Number(result.human_payoff || 0) > 0;
  const lose = Number(result.human_payoff || 0) < 0;
  return (
    <div className="result-banner">
      <div className={`result-chip ${win ? "win" : lose ? "lose" : "tie"}`}>
        <div className="result-title">{result.label || "Hand Complete"}</div>
        <div className="result-amount">{Number(result.human_payoff) > 0 ? "+" : ""}{formatMoney(result.human_payoff)}</div>
      </div>
      <button className="result-close" onClick={onClose}>Close</button>
    </div>
  );
}

function App() {
  const { request } = useApi();
  const [health, setHealth] = useState("unknown");
  const [busy, setBusy] = useState(false);
  const [humanSeat, setHumanSeat] = useState(0);
  const [session, setSession] = useState(defaultSession);
  const [eventLog, setEventLog] = useState([]);
  const [raiseTarget, setRaiseTarget] = useState(0);
  const [resultBanner, setResultBanner] = useState(null);

  const addLog = useCallback((line) => {
    setEventLog((prev) => [...prev.slice(-240), line]);
  }, []);

  useEffect(() => {
    let alive = true;
    const ping = async () => {
      try {
        const h = await request("/api/health");
        if (!alive) return;
        setHealth(h.ok ? "up" : "down");
      } catch {
        if (!alive) return;
        setHealth("down");
      }
    };
    ping();
    const id = setInterval(ping, 7000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [request]);

  const applyPayload = useCallback((p) => {
    setSession((prev) => ({ ...prev, ...p }));
    if (p.result) {
      setResultBanner(p.result);
      addLog(`[RESULT] ${p.result.label} ${formatMoney(p.result.human_payoff)}`);
    }
    const legal = p.legal_actions || [];
    const betLike = legal.filter((a) =>
      [
        ACTION_TYPES.BET_HALF_POT,
        ACTION_TYPES.BET_POT,
        ACTION_TYPES.RAISE_HALF_POT,
        ACTION_TYPES.RAISE_POT,
        ACTION_TYPES.ALL_IN,
      ].includes(a.type)
    );
    if (betLike.length) setRaiseTarget(Number(betLike[0].size || 0));
    if (Array.isArray(p.bot_actions)) {
      for (const ba of p.bot_actions) {
        const hs = ba.hand_strength != null ? Number(ba.hand_strength).toFixed(3) : "n/a";
        const bucketBand = ba.bucket_id != null ? ba.bucket_id : "?";
        const bucketHrId = ba.bucket_hr_id != null ? ba.bucket_hr_id : "?";
        const bucketHrCount = ba.bucket_hr_count != null ? ba.bucket_hr_count : "?";
        const key = ba.infoset_key || ba.prior_key || "-";
        addLog(
          `[BOT] ${ba.street || "-"} ${ba.action?.type || "-"} | hs=${hs} | band10=${bucketBand} | bucket_hr=${bucketHrId}/${bucketHrCount} | key=${key} | pot=${formatMoney(ba.pot)}`
        );
      }
    }
  }, [addLog]);

  const startSession = useCallback(async () => {
    setBusy(true);
    try {
      const payload = await request("/api/new_game", {
        method: "POST",
        body: { human_seat: humanSeat, seats: 2 },
      });
      setEventLog([`Session started. You are seat ${humanSeat} / 2 seats.`]);
      setResultBanner(null);
      applyPayload(payload);
    } catch (err) {
      addLog(`[ERROR] ${err.message}`);
    } finally {
      setBusy(false);
    }
  }, [request, humanSeat, addLog, applyPayload]);

  const nextHand = useCallback(async () => {
    if (!session.session_id) return;
    setBusy(true);
    try {
      const payload = await request("/api/new_hand", {
        method: "POST",
        body: { session_id: session.session_id },
      });
      addLog("---- Next hand ----");
      setResultBanner(null);
      applyPayload(payload);
    } catch (err) {
      addLog(`[ERROR] ${err.message}`);
    } finally {
      setBusy(false);
    }
  }, [request, session.session_id, addLog, applyPayload]);

  const sendAction = useCallback(async (actionIndex) => {
    if (!session.session_id) return;
    setBusy(true);
    try {
      const payload = await request("/api/action", {
        method: "POST",
        body: { session_id: session.session_id, action_index: actionIndex },
      });
      applyPayload(payload);
    } catch (err) {
      addLog(`[ERROR] ${err.message}`);
    } finally {
      setBusy(false);
    }
  }, [request, session.session_id, addLog, applyPayload]);

  const actions = session.awaiting_human_action ? (session.legal_actions || []) : [];
  const stacks = session.state?.stacks || [];
  const board = session.state?.board || [];
  const heroHand = session.state?.your_hand || [];
  const revealedBotHand = session.showdown?.bot_hand || session.state?.bot_hand || [];
  const showBotCards = Boolean(session.terminal && revealedBotHand.length === 2);
  const street = session.state?.street || "-";
  const pot = Number(session.state?.pot || 0);
  const toCall = Number(session.state?.to_call || 0);
  const actionHistory = session.state?.action_history || [];
  const boardSlots = useMemo(() => [0, 1, 2, 3, 4].map((i) => board[i] || null), [board]);

  const botSeat = 1 - humanSeat;
  const heroStack = stacks[humanSeat];
  const botStack = stacks[botSeat];

  const actionIndexByType = useMemo(() => {
    const map = {};
    actions.forEach((a, idx) => {
      map[a.type] = idx;
    });
    return map;
  }, [actions]);

  const doType = (type) => {
    const idx = actionIndexByType[type];
    if (idx == null) return;
    sendAction(idx);
  };

  const betActions = useMemo(() => {
    return actions
      .map((a, idx) => ({ ...a, idx }))
      .filter((a) =>
        [
          ACTION_TYPES.BET_HALF_POT,
          ACTION_TYPES.BET_POT,
          ACTION_TYPES.RAISE_HALF_POT,
          ACTION_TYPES.RAISE_POT,
          ACTION_TYPES.ALL_IN,
        ].includes(a.type)
      );
  }, [actions]);

  const betMin = betActions.length ? Math.max(1, Math.min(...betActions.map((a) => Number(a.size || 0)))) : 1;
  const betMax = betActions.length ? Math.max(1, Math.max(...betActions.map((a) => Number(a.size || 0)))) : 1;

  const sendClosestBet = () => {
    if (!betActions.length) return;
    let best = betActions[0];
    let bestDiff = Math.abs(Number(best.size || 0) - raiseTarget);
    for (const a of betActions) {
      const d = Math.abs(Number(a.size || 0) - raiseTarget);
      if (d < bestDiff) {
        best = a;
        bestDiff = d;
      }
    }
    sendAction(best.idx);
  };

  const canFold = actionIndexByType[ACTION_TYPES.FOLD] != null;
  const canCheck = actionIndexByType[ACTION_TYPES.CHECK] != null;
  const canCall = actionIndexByType[ACTION_TYPES.CALL] != null;
  const canAllIn = actionIndexByType[ACTION_TYPES.ALL_IN] != null;

  return (
    <div className="app-shell">
      <div className="app-backdrop" />
      <div className="app-wrap">
        <header className="topbar">
          <div>
            <div className="eyebrow">Heads-Up Engine Test</div>
            <h1 className="title">Poker Arena Pro Table</h1>
          </div>
          <div className={`health-pill ${health === "up" ? "online" : "offline"}`}>
            <span className="dot" />
            Bot API {health === "up" ? "online" : "offline"}
          </div>
        </header>

        <div className="layout-grid">
          <aside className="side-panel left">
            <div className="panel-block">
              <h2>Session Control</h2>
              <label>Your Seat</label>
              <select value={humanSeat} onChange={(e) => setHumanSeat(Number(e.target.value))}>
                <option value={0}>Seat 0 (SB)</option>
                <option value={1}>Seat 1 (BB)</option>
              </select>
              <div className="btn-row">
                <button disabled={busy} onClick={startSession} className="btn strong">Start Session</button>
                <button disabled={busy || !session.session_id} onClick={nextHand} className="btn">Next Hand</button>
              </div>
            </div>

            <div className="panel-block">
              <h3>Live Hand</h3>
              <div className="kv"><span>Hand</span><strong>#{session.hand_index ?? 0}</strong></div>
              <div className="kv"><span>Street</span><strong>{street}</strong></div>
              <div className="kv"><span>Pot</span><strong>{formatMoney(pot)}</strong></div>
              <div className="kv"><span>To Call</span><strong>{formatMoney(toCall)}</strong></div>
              <div className="kv"><span>Session</span><strong className="mono">{session.session_id || "-"}</strong></div>
            </div>

            <div className="panel-block">
              <h3>Score</h3>
              <div className="score-line">
                W-L-T {session.score?.wins || 0}-{session.score?.losses || 0}-{session.score?.ties || 0}
              </div>
              <div className="score-net">Net {formatMoney(session.score?.net || 0)}</div>
            </div>
          </aside>

          <main className="table-panel">
            <ResultBanner result={resultBanner} onClose={() => setResultBanner(null)} />
            <div className="table-surface">
              <div className="table-ring" />
              <div className="seat bot-seat">
                <div className="seat-head">BOT (Seat {botSeat})</div>
                <div className="cards-row">
                  <PlayingCard
                    card={showBotCards ? revealedBotHand[0] : null}
                    hidden={!showBotCards}
                    delayMs={80}
                    reveal={showBotCards}
                  />
                  <PlayingCard
                    card={showBotCards ? revealedBotHand[1] : null}
                    hidden={!showBotCards}
                    delayMs={130}
                    reveal={showBotCards}
                  />
                </div>
                <div className="seat-stack">Stack {formatMoney(botStack)}</div>
              </div>

              <div className="board-zone">
                <div className="street-chip">{street.toUpperCase()}</div>
                <div className="pot-chip">Pot {formatMoney(pot)}</div>
                <div className="cards-row board">
                  {boardSlots.map((boardCard, i) => (
                    <PlayingCard
                      key={`${session.hand_index}-${i}-${boardCard || "x"}`}
                      card={boardCard}
                      hidden={!boardCard}
                      delayMs={150 + i * 55}
                      reveal={Boolean(boardCard)}
                    />
                  ))}
                </div>
              </div>

              <div className="seat hero-seat">
                <div className="cards-row">
                  <PlayingCard card={heroHand[0]} hidden={!heroHand[0]} delayMs={60} reveal={Boolean(heroHand[0])} />
                  <PlayingCard card={heroHand[1]} hidden={!heroHand[1]} delayMs={105} reveal={Boolean(heroHand[1])} />
                </div>
                <div className="seat-head">YOU (Seat {humanSeat})</div>
                <div className="seat-stack">Stack {formatMoney(heroStack)}</div>
              </div>
            </div>

            <div className="action-dock">
              <div className="action-meta">
                {session.awaiting_human_action ? "Your action" : session.terminal ? "Hand complete" : "Waiting for bot action"}
              </div>
              <div className="action-row">
                <button
                  disabled={busy || !canFold || !session.awaiting_human_action}
                  onClick={() => doType(ACTION_TYPES.FOLD)}
                  className="act fold"
                >
                  Fold
                </button>
                <button
                  disabled={busy || !(canCheck || canCall) || !session.awaiting_human_action}
                  onClick={() => {
                    if (canCheck) doType(ACTION_TYPES.CHECK);
                    else if (canCall) doType(ACTION_TYPES.CALL);
                  }}
                  className="act call"
                >
                  {toCall > 0 ? `Call ${formatMoney(toCall)}` : "Check"}
                </button>
                <button
                  disabled={busy || !canAllIn || !session.awaiting_human_action}
                  onClick={() => doType(ACTION_TYPES.ALL_IN)}
                  className="act shove"
                >
                  All-In
                </button>
              </div>
              <div className="raise-strip">
                <input
                  type="range"
                  min={betMin}
                  max={betMax}
                  step={1}
                  value={raiseTarget}
                  disabled={busy || !betActions.length || !session.awaiting_human_action}
                  onChange={(e) => setRaiseTarget(Number(e.target.value))}
                />
                <span>{formatMoney(raiseTarget)}</span>
                <button
                  disabled={busy || !betActions.length || !session.awaiting_human_action}
                  onClick={sendClosestBet}
                  className="act raise"
                >
                  Bet / Raise
                </button>
              </div>
            </div>
          </main>

          <aside className="side-panel right">
            <div className="panel-block">
              <h3>Action History</h3>
              <div className="history-line">{actionHistory.length ? actionHistory.join(" ") : "-"}</div>
            </div>
            <div className="panel-block grow">
              <h3>Engine Log</h3>
              <div className="log-box">
                {eventLog.length ? eventLog.map((line, idx) => <div key={`${idx}-${line.slice(0, 8)}`}>{line}</div>) : "-"}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

export default App;
