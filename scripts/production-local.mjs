import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environmentPath = path.join(root, ".env.production");
const environmentTemplatePath = path.join(
  root,
  "deploy/production.env.example",
);
const composePath = path.join(root, "compose.production.yml");
const action = process.argv[2];

if (action !== "up" && action !== "down") {
  console.error("Expected either up or down.");
  process.exit(1);
}

function replaceSetting(contents, name, value) {
  const setting = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  return pattern.test(contents)
    ? contents.replace(pattern, setting)
    : `${contents.trimEnd()}\n${setting}\n`;
}

if (!existsSync(environmentPath)) {
  let contents = readFileSync(environmentTemplatePath, "utf8");
  contents = replaceSetting(
    contents,
    "POPULATION_RASTER_HOST_PATH",
    JSON.stringify(path.join(root, "data/population")),
  );
  contents = replaceSetting(
    contents,
    "POPULATION_SERVICE_AUTH_TOKEN",
    randomBytes(32).toString("hex"),
  );
  writeFileSync(environmentPath, contents);
  console.log(`Created ${path.relative(root, environmentPath)} for local Compose.`);
}

function findComposeCommand() {
  if (
    spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0
  ) {
    return { command: "docker", prefix: ["compose"] };
  }
  if (
    spawnSync("docker-compose", ["version"], { stdio: "ignore" }).status === 0
  ) {
    return { command: "docker-compose", prefix: [] };
  }
  throw new Error(
    "Docker Compose was not found. Install Docker Compose and ensure Docker is running.",
  );
}

let compose;
try {
  compose = findComposeCommand();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const composeArguments = [
  ...compose.prefix,
  "--env-file",
  environmentPath,
  "-f",
  composePath,
  action,
];
if (action === "up") composeArguments.push("-d", "--build");

const child = spawn(compose.command, composeArguments, {
  cwd: root,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error("Could not start Docker Compose:", error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
