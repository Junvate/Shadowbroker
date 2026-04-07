const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const frontendDir = path.resolve(__dirname, "..");
const backendLauncher = path.resolve(frontendDir, "..", "start-backend.js");
const nextBin = require.resolve("next/dist/bin/next");
const backendDir = path.resolve(frontendDir, "..", "backend");
const backendVenvCandidates = process.platform === "win32"
  ? [
      path.resolve(backendDir, "venv", "Scripts", "python.exe"),
      path.resolve(backendDir, ".venv", "Scripts", "python.exe"),
      path.resolve(frontendDir, "..", ".venv", "Scripts", "python.exe"),
    ]
  : [
      path.resolve(backendDir, "venv", "bin", "python3"),
      path.resolve(backendDir, ".venv", "bin", "python3"),
      path.resolve(frontendDir, "..", ".venv", "bin", "python3"),
    ];

function hasUvicorn(pythonPath) {
  const probe = spawnSync(pythonPath, ["-c", "import uvicorn"], { stdio: "ignore" });
  return probe.status === 0;
}

const backendPython = backendVenvCandidates.find(
  (candidate) => fs.existsSync(candidate) && hasUvicorn(candidate),
);

/** @type {import("child_process").ChildProcess[]} */
const children = [];

function start(label, file, args, cwd) {
  const child = spawn(file, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    windowsHide: false,
  });

  child.on("error", (error) => {
    console.error(`[${label}] failed to start:`, error);
    shutdown(1);
  });

  child.on("exit", (code, signal) => {
    if (signal || (code ?? 0) !== 0) {
      console.error(`[${label}] exited with ${signal ?? code}`);
      shutdown(typeof code === "number" ? code : 1);
      return;
    }
    shutdown(0);
  });

  children.push(child);
  return child;
}

let shuttingDown = false;

function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start(
  "frontend",
  process.execPath,
  [nextBin, "dev", "--hostname", "127.0.0.1", "--port", "3000"],
  frontendDir,
);

if (backendPython && backendPython.includes(`${path.sep}backend${path.sep}venv${path.sep}`)) {
  start("backend", process.execPath, [backendLauncher], frontendDir);
} else if (backendPython) {
  const backendArgs = ["-m", "uvicorn", "main:app", "--timeout-keep-alive", "120"];
  if (["1", "true", "yes"].includes(String(process.env.BACKEND_RELOAD || "").toLowerCase())) {
    backendArgs.push("--reload");
  }
  start("backend", backendPython, backendArgs, backendDir);
} else {
  console.warn(
    `[backend] skipped: missing Python venv at ${backendVenvCandidates.join(" or ")}. ` +
    "Run start.sh/start.bat in the project root to enable local backend startup.",
  );
}
