/**
 * Release gate for the MCP container image.
 *
 * The image ships a stdio-only MCP server: no listening socket, no HTTP
 * endpoint, no HEALTHCHECK. The gate therefore proves the image over the only
 * interface it has — a JSON-RPC conversation on the container's stdin/stdout —
 * while keeping the hardened runtime posture the deleted compose file used to
 * document (read-only rootfs, dropped capabilities, no-new-privileges, init,
 * tmpfs /tmp).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(await readFile(path.join(root, "release-policy.json"), "utf8"));
const image = "ragnarok-mcp:ci";
const sessionContainer = "ragnarok-release-session";
const persistenceContainer = "ragnarok-release-persistence";
const lockContainer = "ragnarok-release-lock-contender";
const removedEnvContainer = "ragnarok-release-removed-env";
const containers = [sessionContainer, persistenceContainer, lockContainer, removedEnvContainer];
const volume = "ragnarok-release-smoke-data";
const topicName = "Docker Persistence Smoke";
const expectedToolCount = 24;
// Mirrors REMOVED_ENV_VARS in packages/mcp-server/src/config.ts: the image must
// neither bake these in nor tolerate an operator supplying one.
const removedEnvVars = [
  "RAGNAROK_DEPLOYMENT_MODE",
  "RAGNAROK_PORT",
  "RAGNAROK_HTTP_HOST",
  "RAGNAROK_ALLOWED_HOSTS",
  "RAGNAROK_CORS_ORIGIN",
  "RAGNAROK_TLS_CERT_PATH",
  "RAGNAROK_TLS_KEY_PATH",
  "RAGNAROK_API_KEY",
  "RAGNAROK_WRITE_API_KEY",
  "RAGNAROK_ADMIN_API_KEY",
  "RAGNAROK_RATE_LIMIT_PER_MINUTE",
  "RAGNAROK_TRUSTED_PROXIES",
  "RAGNAROK_TRANSFER_TTL_MS",
  "RAGNAROK_TRANSFER_MAX_FILE_BYTES",
  "RAGNAROK_TRANSFER_MAX_AGGREGATE_BYTES",
  "RAGNAROK_TRANSFER_MAX_SESSIONS",
];

// The 2026-07-28 MCP revision is stateless: every request carries the client
// envelope in `_meta` instead of a prior `initialize` handshake.
const envelope = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "ragnarok-docker-gate", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
const capture = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
const containerLogs = (container) => {
  const result = spawnSync("docker", ["logs", container], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Could not read ${container} logs: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout}${result.stderr}`.trim();
};

function hardenedRunArgs(name) {
  return [
    "run",
    "-i",
    "--name",
    name,
    "--init",
    "--read-only",
    "--tmpfs",
    "/tmp:size=256m",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--stop-timeout",
    "20",
    "-v",
    `${volume}:/data/ragnarok`,
  ];
}

/**
 * One `docker run -i` container driven as an MCP stdio peer. Newline-delimited
 * JSON in, newline-delimited JSON out — the same framing the in-repo stdio
 * harness uses against the unpackaged server.
 */
class ContainerSession {
  constructor(name, extraArgs = []) {
    this.name = name;
    this.buffer = "";
    this.messages = [];
    this.waiters = [];
    this.stderrText = "";
    this.nextId = 1;
    this.streamError = undefined;
    this.process = spawn("docker", [...hardenedRunArgs(name), ...extraArgs, image], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => this.process.once("close", (code) => resolve(code)));
    this.process.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.process.stderr.on("data", (chunk) => {
      this.stderrText += chunk.toString("utf8");
    });
  }

  onStdout(chunk) {
    // Never throw out of a stream handler: an uncaught exception here would
    // skip the container cleanup in the gate's `finally`.
    try {
      this.consume(chunk);
    } catch (error) {
      this.streamError = error;
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(error);
      }
    }
  }

  consume(chunk) {
    this.buffer += chunk.toString("utf8");
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // Non-protocol chatter on stdout would corrupt a real client's stream.
        throw new Error(`${this.name} wrote a non-JSON-RPC line to stdout: ${line.slice(0, 200)}`);
      }
      if (message.jsonrpc !== "2.0") {
        throw new Error(`${this.name} wrote a malformed JSON-RPC message: ${line.slice(0, 200)}`);
      }
      this.messages.push(message);
      this.waiters = this.waiters.filter((waiter) => {
        if (!waiter.predicate(message)) {
          return true;
        }
        waiter.resolve(message);
        return false;
      });
    }
  }

  waitFor(predicate, timeoutMs) {
    if (this.streamError) {
      return Promise.reject(this.streamError);
    }
    const existing = this.messages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.name} timed out after ${timeoutMs}ms; stderr: ${this.stderrText.slice(-500)}`)),
        timeoutMs,
      );
      this.waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  async request(method, params = {}, timeoutMs = 180_000) {
    const id = this.nextId++;
    this.process.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: envelope } })}\n`,
    );
    const response = await this.waitFor((message) => message.id === id, timeoutMs);
    if (response.error) {
      throw new Error(`${this.name} ${method} failed: ${JSON.stringify(response.error)}`);
    }
    return response.result;
  }

  async callTool(name, args, timeoutMs = 180_000) {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const text = result.content?.find((item) => item.type === "text")?.text;
    if (!text) {
      throw new Error(`${this.name} tool ${name} returned no text content`);
    }
    const body = JSON.parse(text);
    if (result.isError || body.error) {
      throw new Error(`${this.name} tool ${name} failed: ${body.error ?? "unknown"}`);
    }
    return body;
  }

  /** Close stdin and require the graceful stdio-EOF shutdown path to exit 0. */
  async closeCleanly() {
    this.process.stdin.end();
    const exitCode = await Promise.race([
      this.exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${this.name} did not exit after stdin EOF`)), 60_000),
      ),
    ]);
    if (exitCode !== 0) {
      throw new Error(`${this.name} did not shut down cleanly on stdin EOF: exit ${exitCode}`);
    }
  }
}

async function assertImageContract() {
  const imageBytes = Number(capture("docker", ["image", "inspect", image, "--format", "{{.Size}}"]));
  if (imageBytes > policy.budgets.dockerImageBytes) {
    throw new Error(`Docker image is ${imageBytes} bytes; budget is ${policy.budgets.dockerImageBytes}`);
  }
  const imageUser = capture("docker", ["image", "inspect", image, "--format", "{{.Config.User}}"]);
  if (imageUser !== "node") {
    throw new Error(`Docker runtime user must be node; found ${imageUser || "(root)"}`);
  }
  const expectedArchitecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch;
  const imageArchitecture = capture("docker", ["image", "inspect", image, "--format", "{{.Architecture}}"]);
  if (imageArchitecture !== expectedArchitecture) {
    throw new Error(`Docker architecture ${imageArchitecture} does not match runner ${expectedArchitecture}`);
  }

  const config = JSON.parse(capture("docker", ["image", "inspect", image, "--format", "{{json .Config}}"]));
  const exposedPorts = Object.keys(config.ExposedPorts ?? {});
  if (exposedPorts.length > 0) {
    throw new Error(`A stdio-only image must expose no ports; found ${exposedPorts.join(", ")}`);
  }
  if (config.Healthcheck) {
    throw new Error("A stdio-only image must declare no HEALTHCHECK; a stdio server's liveness is its client's pipe");
  }
  const command = [...(config.Entrypoint ?? []), ...(config.Cmd ?? [])];
  if (command.includes("--http")) {
    throw new Error(`Image command still passes --http: ${command.join(" ")}`);
  }
  if (!command.some((argument) => argument.includes("packages/mcp-server/dist/index.js"))) {
    throw new Error(`Image command does not start the MCP server: ${command.join(" ")}`);
  }
  for (const variable of config.Env ?? []) {
    const name = variable.split("=")[0];
    if (removedEnvVars.includes(name)) {
      throw new Error(`Image bakes in removed variable ${name}`);
    }
  }
  return { imageBytes, imageArchitecture };
}

function assertToolSurface(tools) {
  if (!Array.isArray(tools)) {
    throw new Error("tools/list did not return an array");
  }
  if (tools.length !== expectedToolCount) {
    throw new Error(`Container exposed ${tools.length} tools; the stdio surface is exactly ${expectedToolCount}`);
  }
  const names = new Set(tools.map((tool) => tool.name));
  for (const required of ["rag_query", "rag_create_topic", "rag_list_topics", "rag_memory"]) {
    if (!names.has(required)) {
      throw new Error(`Container tool surface is missing ${required}`);
    }
  }
  for (const removed of ["rag_create_document_upload", "rag_ingest_upload", "rag_import_upload"]) {
    if (names.has(removed)) {
      throw new Error(`Container still exposes the deleted transfer tool ${removed}`);
    }
  }
}

function assertRuntimeHardening(container) {
  if (capture("docker", ["inspect", container, "--format", "{{.HostConfig.ReadonlyRootfs}}"]) !== "true") {
    throw new Error(`${container} root filesystem is not read-only`);
  }
  const securityOptions = JSON.parse(
    capture("docker", ["inspect", container, "--format", "{{json .HostConfig.SecurityOpt}}"]),
  );
  if (!securityOptions.some((option) => option.startsWith("no-new-privileges"))) {
    throw new Error(`${container} lacks no-new-privileges`);
  }
  const droppedCapabilities = JSON.parse(
    capture("docker", ["inspect", container, "--format", "{{json .HostConfig.CapDrop}}"]),
  );
  if (!droppedCapabilities.includes("ALL")) {
    throw new Error(`${container} did not drop ALL capabilities`);
  }
  try {
    run("docker", ["exec", container, "sh", "-c", "touch /app/read-only-probe"]);
    throw new Error(`${container} wrote to its read-only application filesystem`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("wrote to its read-only")) {
      throw error;
    }
  }
  run("docker", [
    "exec",
    container,
    "sh",
    "-c",
    "touch /data/ragnarok/.volume-write-probe && rm /data/ragnarok/.volume-write-probe",
  ]);
}

/**
 * Write config.json into the data volume before the first session.
 *
 * This is the only way to configure a container: the 24 operational settings
 * are file-only, and `-e` does nothing for them. The image sets
 * RAGNAROK_STORAGE_DIR=/data/ragnarok, so this is exactly where the server
 * looks. A throwaway container is the way in — the release container's rootfs
 * is read-only and only the volume is writable.
 */
function seedConfigFile(contents) {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "-v",
      `${volume}:/data/ragnarok`,
      "--entrypoint",
      "sh",
      image,
      "-c",
      "mkdir -p /data/ragnarok && cat > /data/ragnarok/config.json",
    ],
    { cwd: root, encoding: "utf8", input: JSON.stringify(contents), timeout: 60_000 },
  );
  if (result.status !== 0) {
    throw new Error(`Could not seed config.json: ${result.stderr || result.stdout}`);
  }
}

/** A second container on the same volume must fail fast rather than corrupt it. */
async function assertStorageLock() {
  const contender = new ContainerSession(lockContainer);
  try {
    for (let attempt = 0; attempt < 45; attempt++) {
      const exitCode = await Promise.race([
        contender.exited,
        new Promise((resolve) => setTimeout(() => resolve(undefined), 1_000)),
      ]);
      if (exitCode === undefined) {
        continue;
      }
      const logs = contender.stderrText.trim() || containerLogs(lockContainer);
      if (exitCode === 0 || !/lock|already.*(?:held|use)|another.*process/i.test(logs)) {
        throw new Error(`Storage-lock contender failed without the expected lock diagnostic (exit ${exitCode})`);
      }
      return;
    }
    throw new Error("Storage-lock contender remained running instead of failing fast");
  } finally {
    contender.process.kill("SIGKILL");
  }
}

/** The shipped image must abort — not silently ignore — a removed HTTP variable. */
function assertRemovedEnvRejected() {
  const result = spawnSync("docker", [...hardenedRunArgs(removedEnvContainer), "-e", "RAGNAROK_PORT=4000", image], {
    cwd: root,
    encoding: "utf8",
    input: "",
    timeout: 180_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  if (result.status === 0) {
    throw new Error("Container accepted the removed RAGNAROK_PORT variable instead of aborting startup");
  }
  if (!/RAGNAROK_PORT/.test(output)) {
    throw new Error(`Container rejected RAGNAROK_PORT without naming it: ${output.slice(-500)}`);
  }
}

function removeContainers() {
  for (const container of containers) {
    spawnSync("docker", ["rm", "-f", container], { cwd: root, stdio: "ignore" });
  }
}

try {
  removeContainers();
  spawnSync("docker", ["volume", "rm", volume], { cwd: root, stdio: "ignore" });

  const { imageBytes, imageArchitecture } = await assertImageContract();

  run("docker", ["volume", "create", volume]);

  // A non-default value the server reports back, so the assertion below proves
  // the file was read rather than that a built-in default happened to match.
  seedConfigFile({ reranker: { maxCandidates: 7 } });

  // Session 1 — first contact over stdio, on a fresh volume.
  const session = new ContainerSession(sessionContainer);
  await session.request("server/discover");
  assertToolSurface((await session.request("tools/list")).tools);
  assertRuntimeHardening(sessionContainer);
  await assertStorageLock();
  // config.json on the volume is the only way to configure a container, so the
  // gate must prove the container actually reads it. maxCandidates defaults to
  // 20; only the seeded file makes it 7.
  const rerankerInfo = await session.callTool("rag_reranker_info", {});
  if (rerankerInfo.maxCandidates !== 7) {
    throw new Error(`Container ignored the seeded config.json: ${JSON.stringify(rerankerInfo)}`);
  }

  await session.callTool("rag_create_topic", {
    name: topicName,
    description: "Docker restart persistence gate",
  });
  await session.closeCleanly();

  // Session 2 — a brand-new container on the same volume must still see it.
  const restarted = new ContainerSession(persistenceContainer);
  assertToolSurface((await restarted.request("tools/list")).tools);
  const listed = await restarted.callTool("rag_list_topics", {});
  const names = (listed.topics ?? listed).map((topic) => topic.name);
  if (!names.includes(topicName)) {
    throw new Error(`Topic did not survive a container replacement; saw ${JSON.stringify(names)}`);
  }
  await restarted.closeCleanly();

  assertRemovedEnvRejected();

  console.log(
    `Docker stdio release gate passed (${imageBytes} bytes, ${imageArchitecture}, ${expectedToolCount} tools).`,
  );
} finally {
  removeContainers();
  spawnSync("docker", ["volume", "rm", volume], { cwd: root, stdio: "ignore" });
}
