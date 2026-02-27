const { spawn } = require("child_process");

console.log("[start] Launching fullgame logic server on port 8787...");
const fullgameOpts = {
    env: { ...process.env, PORT_API: "8787" },
    stdio: "inherit"
};
const fullgameProc = spawn("node", ["server_fullgame.cjs"], fullgameOpts);

console.log(`[start] Launching proxy server on port ${process.env.PORT || 3000}...`);
const proxyProc = spawn("node", ["server.cjs"], { stdio: "inherit" });

function shutdown() {
    console.log("[start] Shutting down servers...");
    fullgameProc.kill("SIGINT");
    proxyProc.kill("SIGINT");
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
