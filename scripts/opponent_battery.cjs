const { spawnSync } = require("child_process");
const path = require("path");

const HANDS = Number(process.argv[2] || 3000);
const profiles = ["nit", "station", "aggro", "pot_odds", "balanced_mirror"];

function runProfile(profile) {
  const script = path.join(__dirname, "selfplay_metrics.cjs");
  const proc = spawnSync(process.execPath, [script, String(HANDS), profile], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      OPP_PROFILE: profile,
    },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    throw new Error(`profile=${profile} failed\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`);
  }
  const raw = (proc.stdout || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`profile=${profile} invalid JSON output:\n${raw}`);
  }
  const parsed = JSON.parse(raw.slice(start, end + 1));
  return parsed;
}

function pick(summary) {
  return {
    profile: summary.profile,
    hands: summary.hands,
    bot_ev_per_hand: summary.bot_ev_per_hand,
    showdown_rate: summary.showdown_rate,
    showdown_bot_win_pct: summary.showdown_bot_win_pct,
    fold_vs_flop_bet_pct: summary.fold_vs_flop_bet_pct,
    fold_vs_turn_bet_pct: summary.fold_vs_turn_bet_pct,
    bluff_success_rate: summary.bluff_success_rate,
    allin_freq: summary.allin_freq,
    raise_freq_by_street: summary.raise_freq_by_street,
    diag: summary.diag,
  };
}

function main() {
  const out = {
    hands_per_profile: HANDS,
    started_at: new Date().toISOString(),
    profiles: {},
  };
  for (const p of profiles) {
    const res = runProfile(p);
    out.profiles[p] = pick(res);
  }

  const ev = profiles.map((p) => out.profiles[p].bot_ev_per_hand || 0);
  out.aggregate = {
    min_bot_ev_per_hand: Math.min(...ev),
    max_bot_ev_per_hand: Math.max(...ev),
    avg_bot_ev_per_hand: Number((ev.reduce((a, b) => a + b, 0) / Math.max(1, ev.length)).toFixed(4)),
    ready_for_blueprint_v1:
      profiles.every((p) => (out.profiles[p].bot_ev_per_hand || 0) > 0) &&
      profiles.every((p) =>
        (out.profiles[p].diag?.board_invariant_warnings || 0) === 0 &&
        (out.profiles[p].diag?.illegal_state_warnings || 0) === 0
      ),
  };
  console.log(JSON.stringify(out, null, 2));
}

main();
