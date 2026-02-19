import { useEffect, useMemo, useState } from "react";

const formatMoney = (v) => (v == null ? "-" : Number(v).toFixed(2));

const defaultSession = {
  session_id: "",
  hand_index: 0,
  awaiting_human_action: false,
  legal_actions: [],
  state: null,
  terminal: false,
  result: null,
  score: { wins: 0, losses: 0, ties: 0, net: 0 },
  seats: 2,
};

const Card = ({ card, hidden }) => {
  if (hidden) {
    return (
      <img
        className="card-img"
        src="https://deckofcardsapi.com/static/img/back.png"
        alt="card back"
      />
    );
  }
  if (!card) return null;
  const rank = card[0].toUpperCase() === "T" ? "0" : card[0].toUpperCase();
  const suit = card[1]?.toUpperCase() ?? "S";
  const src = `https://deckofcardsapi.com/static/img/${rank}${suit}.png`;
  return (
    <img
      className="card-img"
      src={src}
      alt={card}
      onError={(e) => {
        e.currentTarget.replaceWith(
          Object.assign(document.createElement("div"), {
            className: "h-16 w-12 rounded-md bg-slate-800 grid place-items-center text-xs font-mono",
            textContent: card,
          })
        );
      }}
    />
  );
};

const ActionButton = ({ action, onClick, disabled }) => {
  const label = action.size != null ? `${action.type} (${formatMoney(action.size)})` : action.type;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full text-left px-3 py-2 rounded-lg bg-emerald-600/90 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold shadow"
    >
      {label}
    </button>
  );
};

function useApi() {
  const request = async (path, options = {}) => {
    const res = await fetch(path, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      const msg = data?.error || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  };
  return { request };
}

function App() {
  const { request } = useApi();
  const [health, setHealth] = useState("unknown");
  const [humanSeat, setHumanSeat] = useState(0);
  const [seats, setSeats] = useState(2);
  const [session, setSession] = useState(defaultSession);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);

  const addLog = (line) => setLog((prev) => [...prev.slice(-200), line]);

  useEffect(() => {
    const check = async () => {
      try {
        const h = await request("/api/health");
        if (h.ok) setHealth("up");
        else setHealth("down");
      } catch {
        setHealth("down");
      }
    };
    check();
    const id = setInterval(check, 8000);
    return () => clearInterval(id);
  }, [request]);

  const applyPayload = (p) => {
    setSession((prev) => ({ ...prev, ...p }));
    if (p.result) {
      addLog(`${p.result.label} (${formatMoney(p.result.human_payoff)})`);
    }
    if (p.bot_actions?.length) {
      p.bot_actions.forEach((ba) => {
        const hs = ba.hand_strength != null ? ba.hand_strength.toFixed(3) : "n/a";
        addLog(
          `BOT seat ${ba.seat} | street=${ba.street} | board=${ba.board_class ?? "?"} | bucket=${ba.bucket_id ?? "?"} | hs=${hs} | pot=${ba.pot ?? "?"} | to_call=${ba.to_call ?? "?"} | spr=${ba.spr ?? "?"} | action=${ba.action?.type ?? ""}`
        );
      });
    }
  };

  const startSession = async () => {
    setBusy(true);
    try {
      const p = await request("/api/new_game", {
        method: "POST",
        body: { human_seat: humanSeat, seats },
      });
      setLog([`Session started. You are seat ${humanSeat} / ${seats} seats.`]);
      applyPayload(p);
    } catch (err) {
      addLog(`ERROR: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const nextHand = async () => {
    if (!session.session_id) return;
    setBusy(true);
    try {
      const p = await request("/api/new_hand", {
        method: "POST",
        body: { session_id: session.session_id },
      });
      setLog((prev) => [...prev, "---- Next hand ----"]);
      applyPayload(p);
    } catch (err) {
      addLog(`ERROR: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const sendAction = async (idx) => {
    if (!session.session_id) return;
    setBusy(true);
    try {
      const p = await request("/api/action", {
        method: "POST",
        body: { session_id: session.session_id, action_index: idx },
      });
      applyPayload(p);
    } catch (err) {
      addLog(`ERROR: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const stacks = useMemo(() => session.state?.stacks || [], [session.state]);
  const board = session.state?.board || [];
  const hero = session.state?.your_hand || [];
  const actions = session.awaiting_human_action ? session.legal_actions || [] : [];
  const street = session.state?.street ?? "-";
  const toCall = session.state?.to_call;

  return (
    <div className="min-h-screen px-4 py-6 md:px-8 lg:px-12">
      <div className="max-w-7xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-display font-bold tracking-tight">Poker Arena</h1>
            <p className="text-slate-400">Full-game HU (blinds + preflop→river, solver-backed)</p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span
              className={`inline-flex items-center gap-2 px-3 py-1 rounded-full ${
                health === "up" ? "bg-emerald-900/60 text-emerald-200" : "bg-rose-900/60 text-rose-200"
              }`}
            >
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  health === "up" ? "bg-emerald-400 shadow-[0_0_0_6px_rgba(16,185,129,0.25)]" : "bg-rose-400"
                }`}
              />
              Bot API {health === "up" ? "connected" : "offline"}
            </span>
          </div>
        </header>

        <div className="grid lg:grid-cols-[320px,1fr,320px] gap-5">
          {/* Left panel */}
          <div className="glass rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Session</h2>
              <span className="text-xs text-slate-400">hand #{session.hand_index ?? 0}</span>
            </div>
            <div className="space-y-3">
              <label className="text-xs uppercase tracking-wide text-slate-400">Your Seat</label>
              <select
                className="w-full bg-slate-800/80 border border-white/5 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                value={humanSeat}
                onChange={(e) => setHumanSeat(Number(e.target.value))}
                disabled={busy}
              >
                <option value={0}>Seat 0 (SB preflop, acts first)</option>
                <option value={1}>Seat 1 (BB preflop)</option>
              </select>
              <label className="text-xs uppercase tracking-wide text-slate-400">Seats</label>
              <select
                className="w-full bg-slate-800/80 border border-white/5 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                value={seats}
                onChange={(e) => setSeats(Number(e.target.value))}
                disabled={busy}
              >
                <option value={2}>2 (HU)</option>
                <option value={6}>6 (UI still HU, backend supports)</option>
              </select>
              <button
                onClick={startSession}
                disabled={busy}
                className="w-full h-10 rounded-lg bg-emerald-600 hover:bg-emerald-500 font-semibold shadow disabled:opacity-50"
              >
                Start Session
              </button>
              <button
                onClick={nextHand}
                disabled={!session.session_id || busy}
                className="w-full h-10 rounded-lg bg-slate-700 hover:bg-slate-600 font-semibold shadow disabled:opacity-50"
              >
                Next Hand
              </button>
            </div>

            <div className="text-sm space-y-1 pt-2">
              <div className="text-slate-400">Session ID</div>
              <div className="font-mono text-slate-200 break-all">{session.session_id || "-"}</div>
              <div className="grid grid-cols-2 gap-y-1 text-slate-300">
                <span className="text-slate-400">Street</span>
                <span className="capitalize">{street}</span>
                <span className="text-slate-400">Pot</span>
                <span>{formatMoney(session.state?.pot)}</span>
                <span className="text-slate-400">To Call</span>
                <span>{formatMoney(toCall)}</span>
                <span className="text-slate-400">Stacks</span>
                <span className="font-mono">{JSON.stringify(stacks)}</span>
                <span className="text-slate-400">Board</span>
                <span className="font-mono">{board.join(" ") || "-"}</span>
              </div>
            </div>

            <div className="pt-2">
              <h3 className="text-sm font-semibold mb-2">Actions</h3>
              <div className="space-y-2">
                {actions.length === 0 && (
                  <div className="text-xs text-slate-500">Waiting for bot or terminal.</div>
                )}
                {actions.map((a, i) => (
                  <ActionButton
                    key={`${a.type}-${i}`}
                    action={a}
                    onClick={() => sendAction(i)}
                    disabled={busy || !session.awaiting_human_action}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Center table */}
          <div className="glass rounded-2xl p-4 lg:p-6">
            <div className="bg-gradient-to-b from-table to-table-felt rounded-2xl border border-emerald-900/70 shadow-inner px-6 py-5 min-h-[420px] flex flex-col gap-6 items-center">
              <div className="w-full flex items-center justify-between text-sm text-emerald-100">
                <span className="font-semibold">Button: {humanSeat === 0 ? "Bot" : "You"}</span>
                <span>Street: <span className="capitalize">{street}</span></span>
              </div>
              <div className="flex items-start justify-between w-full">
                <div className="flex flex-col items-center gap-2">
                  <div className="text-xs uppercase tracking-wide text-emerald-50/80">Bot (hidden)</div>
                  <div className="flex gap-2">
                    <Card hidden card="??" />
                    <Card hidden card="??" />
                  </div>
                  <div className="text-xs text-emerald-200">Stack: {formatMoney(stacks[1] ?? "-")}</div>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <div className="text-xs uppercase tracking-wide text-emerald-50/80">Board</div>
                  <div className="flex gap-2">{board.map((c, idx) => <Card key={idx} card={c} />)}</div>
                  <div className="text-lg font-semibold text-emerald-100">
                    Pot: <span className="text-emerald-300">{formatMoney(session.state?.pot)}</span>
                  </div>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <div className="text-xs uppercase tracking-wide text-emerald-50/80">You</div>
                  <div className="flex gap-2">{hero.map((c, idx) => <Card key={idx} card={c} />)}</div>
                  <div className="text-xs text-emerald-200">Stack: {formatMoney(stacks[0] ?? "-")}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Right panel */}
          <div className="glass rounded-2xl p-5 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Score</h2>
              <div className="mt-2 rounded-xl bg-slate-800/60 px-3 py-2 font-mono text-sm">
                W-L-T {session.score.wins}-{session.score.losses}-{session.score.ties} | Net{" "}
                {session.score.net >= 0 ? "+" : ""}
                {formatMoney(session.score.net)}
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold mb-2">Action History</h3>
              <div className="h-24 rounded-xl bg-slate-800/60 px-3 py-2 font-mono text-xs text-slate-300 overflow-auto scroll-thin">
                {session.state?.action_history?.join(" ") || "-"}
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold mb-2">Event Log</h3>
              <div className="h-56 rounded-xl bg-slate-800/60 px-3 py-2 font-mono text-xs text-slate-300 overflow-auto scroll-thin space-y-1">
                {log.map((l, idx) => (
                  <div key={idx}>{l}</div>
                ))}
                {log.length === 0 && <div className="text-slate-500">No events yet.</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
