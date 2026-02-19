const express = require("express");
const crypto = require("crypto");
const app = express();
app.use(express.json());

const SESSIONS = new Map();
function newSession(humanSeat = 0) {
  const id = crypto.randomUUID();
  const s = { id, humanSeat, handIndex: 0, score: { wins:0, losses:0, ties:0, net:0 } };
  SESSIONS.set(id, s);
  return s;
}
function randomBucket() { return Math.floor(Math.random()*200); }
function randomCard() {
  const ranks = "23456789TJQKA";
  const suits = "shdc";
  return ranks[Math.floor(Math.random()*ranks.length)] + suits[Math.floor(Math.random()*suits.length)];
}
function newHand(s) {
  s.handIndex += 1;
  const pot = 50 + Math.floor(Math.random()*50);
  const stacks = [1000,1000];
  const to_call = 0;
  const state = {
    street: "flop",
    pot,
    to_call,
    stacks,
    action_history: [],
    board: [randomCard(),randomCard(),randomCard()],
    your_hand: [randomCard(),randomCard()],
    legal_actions: [
      {type:"CHECK"},
      {type:"BET", size: Math.round(pot/2)},
      {type:"BET", size: pot},
      {type:"ALL_IN", size: stacks[s.humanSeat]},
    ]
  };
  s.state = state;
  s.awaiting = "human";
  return buildPayload(s, []);
}
function buildPayload(s, botActions, terminal=false, result=null) {
  return {
    ok: true,
    session_id: s.id,
    hand_index: s.handIndex,
    awaiting_human_action: s.awaiting === "human" && !terminal,
    bot_actions: botActions,
    state: terminal ? null : s.state,
    terminal,
    result,
    score: s.score,
  };
}
function botAct(s) {
  const legal = s.state.legal_actions;
  // simple policy: if human bet all_in -> 50% call else fold; otherwise random legal.
  let choice = 0;
  if (legal.length>0) {
    choice = Math.floor(Math.random()*legal.length);
  }
  const action = legal[choice];
  const entry = { seat: 1 - s.humanSeat, bucket_id: randomBucket(), action };
  // naive resolution: end hand after bot action
  const payoff = (Math.random()<0.5?1:-1) * (s.state.pot/2);
  if (payoff>0) s.score.wins +=1; else s.score.losses +=1;
  s.score.net += payoff;
  const result = { label: payoff>=0?"You win":"You lose", human_payoff: payoff };
  s.awaiting = "none";
  return buildPayload(s, [entry], true, result);
}

app.get('/api/health', (_req,res)=> res.json({ok:true, status:'stub'}));

app.post('/api/new_game', (req,res)=>{
  const humanSeat = Number(req.body?.human_seat ?? 0) || 0;
  const s = newSession(humanSeat);
  const payload = newHand(s);
  res.json(payload);
});

app.post('/api/new_hand', (req,res)=>{
  const id = req.body?.session_id;
  const s = SESSIONS.get(id);
  if(!s) return res.status(400).json({ok:false,error:'bad session'});
  const payload = newHand(s);
  res.json(payload);
});

app.post('/api/action', (req,res)=>{
  const id = req.body?.session_id;
  const idx = Number(req.body?.action_index);
  const s = SESSIONS.get(id);
  if(!s) return res.status(400).json({ok:false,error:'bad session'});
  const legal = s.state.legal_actions || [];
  if(idx<0 || idx>=legal.length) return res.status(400).json({ok:false,error:'bad action'});
  // we ignore effect; just switch to bot response
  s.awaiting = "bot";
  const payload = botAct(s);
  res.json(payload);
});

const port = 8787;
app.listen(port, ()=> console.log(`stub bot api on ${port}`));
