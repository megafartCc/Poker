const state = {
  sessionId: "",
  handIndex: 0,
  score: { wins: 0, losses: 0, ties: 0, net: 0 },
  humanSeat: 0,
  awaitingAction: false,
  currentState: null,
};

const els = {
  healthDot: document.getElementById("healthDot"),
  healthText: document.getElementById("healthText"),
  seatSelect: document.getElementById("seatSelect"),
  startBtn: document.getElementById("startBtn"),
  nextBtn: document.getElementById("nextBtn"),
  sessionId: document.getElementById("sessionId"),
  handIndex: document.getElementById("handIndex"),
  street: document.getElementById("street"),
  pot: document.getElementById("pot"),
  toCall: document.getElementById("toCall"),
  stacks: document.getElementById("stacks"),
  actions: document.getElementById("actions"),
  boardCards: document.getElementById("boardCards"),
  heroCards: document.getElementById("heroCards"),
  botCards: document.getElementById("botCards"),
  potCenter: document.getElementById("potCenter"),
  scoreLine: document.getElementById("scoreLine"),
  history: document.getElementById("history"),
  log: document.getElementById("log"),
};

function cardToDeckImage(card) {
  if (!card || card.length < 2) return "https://deckofcardsapi.com/static/img/back.png";
  const rank = card[0].toUpperCase() === "T" ? "0" : card[0].toUpperCase();
  const suit = card[1].toUpperCase();
  return `https://deckofcardsapi.com/static/img/${rank}${suit}.png`;
}

function addLog(text, cls = "line-info") {
  const line = document.createElement("div");
  line.className = cls;
  line.textContent = text;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

async function api(path, method = "GET", body = null) {
  const options = { method, headers: {} };
  if (body !== null) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function setHealth(ok, text) {
  els.healthDot.classList.remove("online", "offline");
  els.healthDot.classList.add(ok ? "online" : "offline");
  els.healthText.textContent = text;
}

function renderCards(container, cards, hidden = false, count = 2) {
  container.innerHTML = "";
  if (hidden) {
    for (let i = 0; i < count; i += 1) {
      const img = document.createElement("img");
      img.className = "card-img";
      img.src = "https://deckofcardsapi.com/static/img/back.png";
      img.alt = "card back";
      container.appendChild(img);
    }
    return;
  }
  if (!cards || cards.length === 0) {
    return;
  }
  for (const card of cards) {
    const img = document.createElement("img");
    img.className = "card-img";
    img.src = cardToDeckImage(card);
    img.alt = card;
    img.onerror = () => {
      const fallback = document.createElement("div");
      fallback.className = "card-fallback";
      fallback.textContent = card;
      img.replaceWith(fallback);
    };
    container.appendChild(img);
  }
}

function renderScore() {
  const s = state.score;
  const sign = s.net >= 0 ? "+" : "";
  els.scoreLine.textContent = `W-L-T ${s.wins}-${s.losses}-${s.ties} | Net ${sign}${s.net.toFixed(2)}`;
}

function actionLabel(action) {
  const t = String(action.type || "").toUpperCase();
  if (action.size == null) return t;
  return `${t} ${action.size}`;
}

function renderActions(payload) {
  els.actions.innerHTML = "";
  if (!payload.awaiting_human_action || !payload.state) return;
  const legal = payload.state.legal_actions || [];
  legal.forEach((action, idx) => {
    const btn = document.createElement("button");
    btn.className = "action-btn";
    btn.textContent = `${idx}. ${actionLabel(action)}`;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const out = await api("/api/action", "POST", {
          session_id: state.sessionId,
          action_index: idx,
        });
        renderPayload(out);
      } catch (err) {
        addLog(`ERROR: ${err.message}`, "line-loss");
        btn.disabled = false;
      }
    };
    els.actions.appendChild(btn);
  });
}

function renderStateInfo(s) {
  if (!s) {
    els.street.textContent = "-";
    els.pot.textContent = "-";
    els.toCall.textContent = "-";
    els.stacks.textContent = "-";
    els.history.textContent = "-";
    els.potCenter.textContent = "0";
    return;
  }
  els.street.textContent = s.street || "-";
  els.pot.textContent = String(s.pot ?? "-");
  els.toCall.textContent = String(s.to_call ?? "-");
  els.stacks.textContent = JSON.stringify(s.stacks || []);
  els.history.textContent = (s.action_history || []).join(" | ") || "-";
  els.potCenter.textContent = String(s.pot ?? 0);
}

function renderPayload(payload) {
  state.sessionId = payload.session_id || state.sessionId;
  state.handIndex = payload.hand_index || state.handIndex;
  state.score = payload.score || state.score;
  state.awaitingAction = !!payload.awaiting_human_action;
  state.currentState = payload.state || null;

  els.sessionId.textContent = state.sessionId || "-";
  els.handIndex.textContent = String(state.handIndex || "-");
  renderScore();
  renderStateInfo(payload.state);
  renderActions(payload);

  if (payload.state) {
    const board = payload.state.board || [];
    const hero = payload.state.your_hand || [];
    renderCards(els.boardCards, board, false, 5);
    renderCards(els.heroCards, hero, false, 2);
    renderCards(els.botCards, [], true, 2);
  }

  if (Array.isArray(payload.bot_actions)) {
    payload.bot_actions.forEach((entry) => {
      const action = actionLabel(entry.action || {});
      addLog(`BOT [seat ${entry.seat}] -> ${action} (bucket ${entry.bucket_id})`);
    });
  }

  if (payload.terminal && payload.result) {
    const value = Number(payload.result.human_payoff || 0);
    const sign = value >= 0 ? "+" : "";
    const cls = value > 0 ? "line-win" : value < 0 ? "line-loss" : "line-info";
    addLog(`${payload.result.label} (${sign}${value.toFixed(2)})`, cls);
    els.nextBtn.disabled = false;
    els.actions.innerHTML = "";
  } else {
    els.nextBtn.disabled = true;
  }
}

async function startSession() {
  els.log.innerHTML = "";
  els.actions.innerHTML = "";
  state.humanSeat = Number(els.seatSelect.value);
  try {
    const payload = await api("/api/new_game", "POST", { human_seat: state.humanSeat });
    addLog(`Session started. You are seat ${state.humanSeat}.`);
    renderPayload(payload);
  } catch (err) {
    addLog(`Failed to start session: ${err.message}`, "line-loss");
  }
}

async function nextHand() {
  if (!state.sessionId) return;
  try {
    const payload = await api("/api/new_hand", "POST", { session_id: state.sessionId });
    addLog("---- Next hand ----");
    renderPayload(payload);
  } catch (err) {
    addLog(`Failed to start next hand: ${err.message}`, "line-loss");
  }
}

async function bootHealth() {
  try {
    const data = await api("/api/health");
    if (data.ok) {
      setHealth(true, "Bot API connected");
      return;
    }
    setHealth(false, "Bot API unreachable");
  } catch (_err) {
    setHealth(false, "Bot API unreachable");
  }
}

els.startBtn.onclick = startSession;
els.nextBtn.onclick = nextHand;

bootHealth();
