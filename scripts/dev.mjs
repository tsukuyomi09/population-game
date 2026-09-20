import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

process.chdir(root);
loadEnvConfig(root, true);

const pythonExecutable =
  process.env.POPULATION_PYTHON ??
  path.join(
    root,
    ".venv-population",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );

if (!existsSync(pythonExecutable)) {
  console.error(
    "Population Python environment is missing. Run: " +
      "python3 -m venv .venv-population && " +
      ".venv-population/bin/python -m pip install -r tools/population/requirements.txt",
  );
  process.exit(1);
}

const servicePort = process.env.POPULATION_SERVICE_PORT ?? "8001";
const developmentEnvironment = {
  ...process.env,
  POPULATION_PROVIDER: process.env.POPULATION_PROVIDER ?? "local",
  POPULATION_RASTER_PATH:
    process.env.POPULATION_RASTER_PATH ?? path.join(root, "data/population"),
  POPULATION_TILE_INDEX_PATH:
    process.env.POPULATION_TILE_INDEX_PATH ??
    path.join(root, "artifacts/population/tile-index"),
  POPULATION_SERVICE_HOST: process.env.POPULATION_SERVICE_HOST ?? "127.0.0.1",
  POPULATION_SERVICE_PORT: servicePort,
  POPULATION_SERVICE_URL:
    process.env.POPULATION_SERVICE_URL ?? `http://127.0.0.1:${servicePort}`,
};

const commands = [
  {
    name: "population",
    command: pythonExecutable,
    args: [path.join(root, "tools/population/service.py")],
  },
  {
    name: "web",
    command: process.execPath,
    args: [require.resolve("next/dist/bin/next"), "dev"],
  },
];

const children = [];
let shuttingDown = false;
let remainingChildren = commands.length;
let finalExitCode = 0;
let forceShutdownTimer;

function signalChild(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function shutdown(signal, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  finalExitCode = exitCode;

  for (const child of children) signalChild(child, signal);

  forceShutdownTimer = setTimeout(() => {
    for (const child of children) signalChild(child, "SIGKILL");
  }, 5_000);
  forceShutdownTimer.unref();
}

for (const command of commands) {
  const child = spawn(command.command, command.args, {
    cwd: root,
    detached: process.platform !== "win32",
    env: developmentEnvironment,
    stdio: "inherit",
  });
  children.push(child);

  child.on("error", (error) => {
    console.error(`Could not start ${command.name}:`, error);
    shutdown("SIGTERM", 1);
  });

  child.on("close", (code, signal) => {
    remainingChildren -= 1;

    if (!shuttingDown) {
      console.error(
        `${command.name} exited ${signal ? `with ${signal}` : `with code ${code}`}.`,
      );
      shutdown("SIGTERM", code ?? 1);
    }

    if (remainingChildren === 0) {
      clearTimeout(forceShutdownTimer);
      process.exitCode = finalExitCode;
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT", 0));
process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGHUP", () => shutdown("SIGHUP", 0));
