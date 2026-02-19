/**
 * Thin wrapper to call pokerbot_cli solve-realtime.
 * Returns parsed action probabilities and chosen action.
 */
const { spawn } = require("child_process");
const path = require("path");

function solveRealtime({ seats = 2, heroSeat = 0, street = "flop", buckets, blueprint, thinkMs = 1000 }) {
  return new Promise((resolve, reject) => {
    const exe = path.join(__dirname, "bin", "pokerbot_cli.exe");
    const args = [
      "solve-realtime",
      "--seats",
      String(seats),
      "--hero-seat",
      String(heroSeat),
      "--street",
      street,
      "--buckets",
      buckets,
      "--blueprint",
      blueprint,
      "--think-ms",
      String(thinkMs),
      "--depth-limit",
      "5",
    ];
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(out || `solver exit ${code}`));
      const line = out.trim().split("\n").find((l) => l.startsWith("realtime_solve_ok"));
      if (!line) return reject(new Error("no solver output"));
      const fields = Object.fromEntries(
        line
          .split(" ")
          .slice(1)
          .map((kv) => kv.split("="))
          .filter((p) => p.length === 2)
      );
      const probs = [
        Number(fields.fold || 0),
        Number(fields.check || 0),
        Number(fields.call || 0),
        Number(fields.bet || fields.bet_half || 0),
        Number(fields.raise || fields.raise_half || 0),
        Number(fields.all_in || 0),
      ];
      resolve({ probs, chosen: fields.chosen || "" });
    });
  });
}

module.exports = { solveRealtime };
