const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const frontendDir = path.resolve(__dirname, "..");
const backendDir = path.resolve(frontendDir, "..", "backend");
const frontendHost = String(process.env.FRONTEND_HOST || "0.0.0.0");
const frontendPort = String(process.env.FRONTEND_PORT || "6789");
const backendHost = String(process.env.BACKEND_HOST || "0.0.0.0");
const backendPort = String(process.env.BACKEND_PORT || "8000");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const backendVenvDir = path.resolve(backendDir, "venv");
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
const backendVenvPython = process.platform === "win32"
  ? path.resolve(backendVenvDir, "Scripts", "python.exe")
  : path.resolve(backendVenvDir, "bin", "python3");
const backendBootstrapPythonCandidates = process.platform === "win32"
  ? [process.env.PYTHON, "py", "python", "python3"].filter(Boolean)
  : [process.env.PYTHON, "python3", "python"].filter(Boolean);

function runSyncChecked(file, args, cwd, label) {
  const result = spawnSync(file, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
    windowsHide: false,
  });
  if (result.status !== 0) {
    console.error(`[${label}] failed with exit code ${result.status ?? 1}`);
    process.exit(result.status ?? 1);
  }
}

function commandExists(command, args = ["--version"]) {
  const probe = spawnSync(command, args, { stdio: "ignore", windowsHide: true });
  return probe.status === 0;
}

function hasBackendRuntime(pythonPath) {
  const probe = spawnSync(
    pythonPath,
    ["-c", "import uvicorn, fastapi, cachetools, orjson"],
    { stdio: "ignore" },
  );
  return probe.status === 0;
}

function ensureFrontendDeps() {
  const nextPkg = path.resolve(frontendDir, "node_modules", "next", "package.json");
  if (fs.existsSync(nextPkg)) {
    return;
  }
  console.log("[frontend] Installing Node.js dependencies...");
  runSyncChecked(npmCmd, ["install"], frontendDir, "frontend deps");
}

function detectBackendPython() {
  return backendVenvCandidates.find((candidate) => fs.existsSync(candidate) && hasBackendRuntime(candidate));
}

function detectBootstrapPython() {
  for (const candidate of backendBootstrapPythonCandidates) {
    const probeArgs = process.platform === "win32" && candidate === "py" ? ["-3", "--version"] : ["--version"];
    const probe = spawnSync(candidate, probeArgs, { stdio: "ignore", windowsHide: true });
    if (probe.status === 0) {
      return candidate;
    }
  }
  return null;
}

function ensureBackendPython() {
  let backendPython = detectBackendPython();
  if (backendPython) {
    return backendPython;
  }

  const bootstrapPython = detectBootstrapPython();
  if (!bootstrapPython) {
    console.warn("[backend] skipped: Python 3 not found in PATH.");
    return null;
  }

  if (!fs.existsSync(backendVenvPython)) {
    console.log(`[backend] Creating virtualenv at ${backendVenvDir}`);
    const createArgs = process.platform === "win32" && bootstrapPython === "py"
      ? ["-3", "-m", "venv", backendVenvDir]
      : ["-m", "venv", backendVenvDir];
    runSyncChecked(bootstrapPython, createArgs, backendDir, "backend venv");
  }

  if (!hasBackendRuntime(backendVenvPython)) {
    console.log("[backend] Installing Python dependencies (first run only)...");
    if (commandExists("uv")) {
      runSyncChecked("uv", ["sync", "--frozen", "--no-dev"], path.resolve(backendDir, ".."), "backend uv sync");
    } else {
      runSyncChecked(backendVenvPython, ["-m", "pip", "install", "--upgrade", "pip"], backendDir, "backend pip upgrade");
      runSyncChecked(backendVenvPython, ["-m", "pip", "install", "-e", "."], backendDir, "backend pip install");
    }
  }

  backendPython = detectBackendPython();
  if (!backendPython) {
    console.warn(
      `[backend] skipped: unable to prepare a Python runtime with uvicorn at ${backendVenvCandidates.join(" or ")}.`,
    );
  }
  return backendPython;
}

function formatHostForUrl(host) {
  const raw = String(host || "").trim();
  if (!raw) return "127.0.0.1";
  if (raw.includes(":") && !raw.startsWith("[")) {
    return `[${raw}]`;
  }
  return raw;
}

function defaultBackendConnectHost() {
  const explicit = String(process.env.BACKEND_CONNECT_HOST || "").trim();
  if (explicit) {
    return explicit;
  }
  const normalized = backendHost.toLowerCase();
  if (normalized === "0.0.0.0") return "127.0.0.1";
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return "::1";
  return backendHost;
}

ensureFrontendDeps();
const nextBin = require.resolve("next/dist/bin/next");
const backendPython = ensureBackendPython();
const backendUrl =
  process.env.BACKEND_URL ||
  `http://${formatHostForUrl(defaultBackendConnectHost())}:${backendPort}`;

/** @type {import("child_process").ChildProcess[]} */
const children = [];

function start(label, file, args, cwd, envOverrides = {}) {
  const child = spawn(file, args, {
    cwd,
    env: { ...process.env, ...envOverrides },
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
  [nextBin, "dev", "--hostname", frontendHost, "--port", frontendPort],
  frontendDir,
  { BACKEND_URL: backendUrl },
);

if (backendPython) {
  const backendArgs = ["-m", "uvicorn", "main:app", "--timeout-keep-alive", "120"];
  backendArgs.push("--host", backendHost);
  backendArgs.push("--port", backendPort);
  if (["1", "true", "yes"].includes(String(process.env.BACKEND_RELOAD || "").toLowerCase())) {
    backendArgs.push("--reload");
  }
  start("backend", backendPython, backendArgs, backendDir);
} else {
  console.warn("[backend] skipped: backend runtime is unavailable.");
}
