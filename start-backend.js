const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const backendDir = path.resolve(__dirname, "backend");
const backendHost = String(process.env.BACKEND_HOST || "0.0.0.0");
const backendPort = String(process.env.BACKEND_PORT || "8000");
const repoRoot = __dirname;
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
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

function runSyncChecked(file, args, cwd, label, envOverrides = {}) {
  const result = spawn(file, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...envOverrides },
  });
  return new Promise((resolve, reject) => {
    result.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`[${label}] failed with exit code ${code ?? 1}`));
    });
    result.on("error", reject);
  });
}

function hasBackendRuntime(pythonPath) {
  const probe = spawn(pythonPath, ["-c", "import uvicorn, fastapi, cachetools, orjson"], {
    stdio: "ignore",
  });
  return new Promise((resolve) => {
    probe.on("exit", (code) => resolve(code === 0));
    probe.on("error", () => resolve(false));
  });
}

function buildVenvEnv(pythonPath) {
  const binDir = path.dirname(pythonPath);
  const venvDir = path.dirname(binDir);
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  return {
    VIRTUAL_ENV: venvDir,
    [pathKey]: `${binDir}${path.delimiter}${process.env[pathKey] || ""}`,
  };
}

async function ensureBackendNodeDeps() {
  const backendPkg = path.join(backendDir, "package.json");
  const wsPkg = path.join(backendDir, "node_modules", "ws", "package.json");
  if (!fs.existsSync(backendPkg) || fs.existsSync(wsPkg)) {
    return;
  }

  console.log("[*] Backend Node.js deps missing, installing backend/package.json dependencies...");
  try {
    await runSyncChecked(
      npmCmd,
      ["install", "--no-fund", "--no-audit"],
      backendDir,
      "backend npm install",
    );
  } catch (error) {
    console.warn(
      `[!] Backend Node.js dependency install failed; AIS proxy may stay degraded. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function ensureBackendRuntime() {
  if (await hasBackendRuntime(venvBin)) {
    return;
  }
  console.log("[*] Backend runtime missing in venv, installing dependencies...");
  try {
    await runSyncChecked(
      "uv",
      ["sync", "--frozen", "--no-dev", "--active", "--package", "backend"],
      repoRoot,
      "backend uv sync",
      buildVenvEnv(venvBin),
    );
  } catch (error) {
    console.warn(String(error instanceof Error ? error.message : error));
  }
  if (await hasBackendRuntime(venvBin)) {
    return;
  }
  await runSyncChecked(venvBin, ["-m", "pip", "install", "--upgrade", "pip"], backendDir, "backend pip upgrade");
  await runSyncChecked(venvBin, ["-m", "pip", "install", "-e", "."], backendDir, "backend pip install");
}

const backendArgs = ["-m", "uvicorn", "main:app", "--timeout-keep-alive", "120"];
backendArgs.push("--host", backendHost);
backendArgs.push("--port", backendPort);
if (["1", "true", "yes"].includes(String(process.env.BACKEND_RELOAD || "").toLowerCase())) {
  backendArgs.push("--reload");
}

async function main() {
  await ensureBackendNodeDeps();
  await ensureBackendRuntime();
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
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
