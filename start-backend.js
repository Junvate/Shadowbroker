const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const backendDir = path.resolve(__dirname, "backend");
const backendHost = String(process.env.BACKEND_HOST || "0.0.0.0");
const backendPort = String(process.env.BACKEND_PORT || "8000");
const pythonCandidates = process.platform === "win32"
  ? [
      path.join(backendDir, "venv", "Scripts", "python.exe"),
      path.join(backendDir, ".venv", "Scripts", "python.exe"),
      path.join(__dirname, ".venv", "Scripts", "python.exe"),
    ]
  : [
      path.join(backendDir, "venv", "bin", "python3"),
      path.join(backendDir, ".venv", "bin", "python3"),
      path.join(__dirname, ".venv", "bin", "python3"),
    ];
const venvBin = pythonCandidates.find((candidate) => fs.existsSync(candidate));

if (!venvBin) {
  console.error(`[!] Python venv not found. Checked: ${pythonCandidates.join(", ")}`);
  console.error("[!] Run start.sh (Mac/Linux) or start.bat (Windows) first to create the venv.");
  process.exit(1);
}

const backendArgs = ["-m", "uvicorn", "main:app", "--timeout-keep-alive", "120"];
backendArgs.push("--host", backendHost);
backendArgs.push("--port", backendPort);
if (["1", "true", "yes"].includes(String(process.env.BACKEND_RELOAD || "").toLowerCase())) {
  backendArgs.push("--reload");
}

console.log(`[*] Starting backend with: ${venvBin} ${backendArgs.join(" ")}`);
const backendProc = spawn(venvBin, backendArgs, {
  cwd: backendDir,
  stdio: "inherit",
  env: process.env,
});

const cleanupAll = () => {
  if (backendProc && !backendProc.killed) {
    backendProc.kill();
  }
};

process.on("exit", cleanupAll);
process.on("SIGINT", () => {
  cleanupAll();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupAll();
  process.exit(0);
});

backendProc.on("exit", (code) => {
  cleanupAll();
  process.exit(code ?? 0);
});
