import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(await readFile(path.join(root, "release-policy.json"), "utf8"));
const image = "ragnarok-mcp:ci";
const sharedContainer = "ragnarok-release-shared";
const localContainer = "ragnarok-release-local";
const proxyContainer = "ragnarok-release-proxy";
const lockContainer = "ragnarok-release-lock-contender";
const containers = [sharedContainer, localContainer, proxyContainer, lockContainer];
const volume = "ragnarok-release-smoke-data";
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
const capture = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
const containerLogs = (container) => {
  const result = spawnSync("docker", ["logs", container], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not read ${container} logs: ${result.stderr || result.stdout}`);
  return `${result.stdout}${result.stderr}`.trim();
};
// Keep bind-mounted fixtures under the checkout. Docker Desktop, Colima, and
// remote Linux daemons do not necessarily share the host temporary directory.
const certificates = await mkdtemp(path.join(root, ".docker-tls-"));
const certPath = path.join(certificates, "tls.crt");
const keyPath = path.join(certificates, "tls.key");
const readerToken = "ci-reader-token-000000000000000000000001";
const curatorToken = "ci-curator-token-0000000000000000000001";
const adminToken = "ci-admin-token-000000000000000000000001";
const localToken = "ci-local-owner-token-000000000000000000001";

async function requestStatus({
  pathname,
  method = "GET",
  protocol = "https",
  host = "localhost",
  headers = {},
}) {
  const options = {
    hostname: "127.0.0.1",
    port: 4000,
    path: pathname,
    method,
    headers: { host, ...headers },
    timeout: 4_000,
  };
  if (protocol === "https") {
    options.ca = await readFile(certPath);
    options.servername = "localhost";
  }
  return new Promise((resolve, reject) => {
    const request = (protocol === "https" ? httpsRequest : httpRequest)(options, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("timeout", () => request.destroy(new Error(`${protocol.toUpperCase()} Docker gate request timed out`)));
    request.on("error", reject);
    request.end();
  });
}

async function ready(configuration, label, container) {
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      if ((await requestStatus({ ...configuration, pathname: "/ready" })) === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const logs = container ? containerLogs(container) : "";
  throw new Error(`${label} container did not become ready${logs ? `:\n${logs}` : ""}`);
}

async function waitForHealth(container) {
  for (let attempt = 0; attempt < 65; attempt++) {
    const health = capture("docker", ["inspect", container, "--format", "{{.State.Health.Status}}"]);
    if (health === "healthy") return;
    if (health === "unhealthy") throw new Error(`${container} image health check reported unhealthy`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${container} image health check did not report healthy`);
}

async function assertPlaintextRejected() {
  await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: 4000, path: "/health", timeout: 4_000 }, (response) => {
      response.resume();
      reject(new Error(`Native TLS port unexpectedly answered plaintext HTTP with ${response.statusCode}`));
    });
    request.on("timeout", () => request.destroy(new Error("Plaintext probe timed out")));
    request.on("error", () => resolve());
    request.end();
  });
}

function hardenedRunArgs(name) {
  return [
    "run",
    "-d",
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
  ];
}

function nativeTlsArgs(mode, token, name, publishPort = true) {
  return [
    ...hardenedRunArgs(name),
    ...(publishPort ? ["-p", "4000:4000"] : []),
    "-v",
    `${volume}:/data/ragnarok`,
    "-v",
    `${certPath}:/run/secrets/ragnarok_tls_cert:ro`,
    "-v",
    `${keyPath}:/run/secrets/ragnarok_tls_key:ro`,
    "-v",
    `${certPath}:/run/secrets/ragnarok_tls_ca:ro`,
    "-e",
    `RAGNAROK_DEPLOYMENT_MODE=${mode}`,
    "-e",
    `RAGNAROK_API_KEY=${token}`,
    ...(mode === "shared"
      ? [
          "-e",
          `RAGNAROK_WRITE_API_KEY=${curatorToken}`,
          "-e",
          `RAGNAROK_ADMIN_API_KEY=${adminToken}`,
        ]
      : []),
    "-e",
    "RAGNAROK_TLS_CERT_PATH=/run/secrets/ragnarok_tls_cert",
    "-e",
    "RAGNAROK_TLS_KEY_PATH=/run/secrets/ragnarok_tls_key",
    "-e",
    "RAGNAROK_TLS_CA_PATH=/run/secrets/ragnarok_tls_ca",
    "-e",
    "RAGNAROK_TLS_SERVER_NAME=localhost",
    "-e",
    "RAGNAROK_ALLOWED_HOSTS=localhost",
    "-e",
    "RAGNAROK_CORS_ORIGIN=https://ci.example",
    image,
  ];
}

async function stopGracefully(container) {
  run("docker", ["stop", "--timeout", "20", container]);
  const exitCode = capture("docker", ["inspect", container, "--format", "{{.State.ExitCode}}"]);
  if (exitCode !== "0") throw new Error(`${container} did not stop gracefully: exit ${exitCode}`);
}

async function assertStorageLock() {
  run("docker", nativeTlsArgs("shared", readerToken, lockContainer, false));
  for (let attempt = 0; attempt < 15; attempt++) {
    const running = capture("docker", ["inspect", lockContainer, "--format", "{{.State.Running}}"]);
    if (running === "false") {
      const exitCode = capture("docker", ["inspect", lockContainer, "--format", "{{.State.ExitCode}}"]);
      const logs = containerLogs(lockContainer);
      if (exitCode === "0" || !/lock|already.*(?:held|use)|another.*process/i.test(logs)) {
        throw new Error(`Storage-lock contender failed without the expected lock diagnostic (exit ${exitCode})`);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Storage-lock contender remained running instead of failing fast");
}

try {
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,DNS:ragnarok-mcp,IP:127.0.0.1",
    "-keyout",
    keyPath,
    "-out",
    certPath,
  ]);
  await chmod(certPath, 0o444);
  await chmod(keyPath, 0o444);

  for (const container of containers) {
    try {
      run("docker", ["rm", "-f", container]);
    } catch {}
  }
  try {
    run("docker", ["volume", "rm", volume]);
  } catch {}

  const imageBytes = Number(capture("docker", ["image", "inspect", image, "--format", "{{.Size}}"]));
  if (imageBytes > policy.budgets.dockerImageBytes) {
    throw new Error(`Docker image is ${imageBytes} bytes; budget is ${policy.budgets.dockerImageBytes}`);
  }
  const imageUser = capture("docker", ["image", "inspect", image, "--format", "{{.Config.User}}"]);
  if (imageUser !== "node") throw new Error(`Docker runtime user must be node; found ${imageUser || "(root)"}`);
  const expectedArchitecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch;
  const imageArchitecture = capture("docker", ["image", "inspect", image, "--format", "{{.Architecture}}"]);
  if (imageArchitecture !== expectedArchitecture) {
    throw new Error(`Docker architecture ${imageArchitecture} does not match runner ${expectedArchitecture}`);
  }

  run("docker", ["volume", "create", volume]);
  const sharedArgs = nativeTlsArgs("shared", readerToken, sharedContainer);
  run("docker", sharedArgs);
  await ready({ protocol: "https", host: "localhost" }, "shared native-TLS", sharedContainer);
  await waitForHealth(sharedContainer);
  await assertPlaintextRejected();
  if ((await requestStatus({ pathname: "/health", host: "not-allowed.example" })) !== 403) {
    throw new Error("Shared native-TLS container accepted a Host outside RAGNAROK_ALLOWED_HOSTS");
  }
  const unauthorizedStatus = await requestStatus({ pathname: "/mcp", method: "POST" });
  if (unauthorizedStatus !== 401) throw new Error(`Unauthenticated MCP request returned ${unauthorizedStatus}`);
  if (capture("docker", ["inspect", sharedContainer, "--format", "{{.HostConfig.ReadonlyRootfs}}"]) !== "true") {
    throw new Error("Shared container root filesystem is not read-only");
  }
  const securityOptions = JSON.parse(
    capture("docker", ["inspect", sharedContainer, "--format", "{{json .HostConfig.SecurityOpt}}"]),
  );
  if (!securityOptions.some((option) => option.startsWith("no-new-privileges"))) {
    throw new Error("Shared container lacks no-new-privileges");
  }
  try {
    run("docker", ["exec", sharedContainer, "sh", "-c", "touch /app/read-only-probe"]);
    throw new Error("Shared container wrote to its read-only application filesystem");
  } catch (error) {
    if (error instanceof Error && error.message.includes("wrote to its read-only")) throw error;
  }
  run("docker", [
    "exec",
    sharedContainer,
    "sh",
    "-c",
    "touch /data/ragnarok/.volume-write-probe && rm /data/ragnarok/.volume-write-probe",
  ]);

  const smokeEnv = {
    ...process.env,
    NODE_EXTRA_CA_CERTS: certPath,
    RAGNAROK_SMOKE_URL: "https://localhost:4000/mcp",
    RAGNAROK_API_KEY: readerToken,
    RAGNAROK_WRITE_API_KEY: curatorToken,
    RAGNAROK_ADMIN_API_KEY: adminToken,
  };
  run("node", ["scripts/docker-smoke.mjs", "create"], { env: smokeEnv });
  run("node", ["scripts/docker-smoke.mjs", "admin"], { env: smokeEnv });
  await assertStorageLock();
  await stopGracefully(sharedContainer);
  run("docker", ["start", sharedContainer]);
  await ready({ protocol: "https", host: "localhost" }, "restarted shared native-TLS", sharedContainer);
  run("node", ["scripts/docker-smoke.mjs", "verify"], { env: smokeEnv });
  await stopGracefully(sharedContainer);

  run("docker", nativeTlsArgs("local", localToken, localContainer));
  await ready({ protocol: "https", host: "localhost" }, "local native-TLS", localContainer);
  await waitForHealth(localContainer);
  run("node", ["scripts/docker-smoke.mjs", "local"], {
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: certPath,
      RAGNAROK_SMOKE_URL: "https://localhost:4000/mcp",
      RAGNAROK_API_KEY: localToken,
    },
  });
  await stopGracefully(localContainer);

  const bridgeGateway = capture("docker", [
    "network",
    "inspect",
    "bridge",
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
  ]);
  run("docker", [
    ...hardenedRunArgs(proxyContainer),
    "-p",
    "4000:4000",
    "-v",
    `${volume}:/data/ragnarok`,
    "-e",
    "RAGNAROK_DEPLOYMENT_MODE=shared",
    "-e",
    `RAGNAROK_API_KEY=${readerToken}`,
    "-e",
    `RAGNAROK_WRITE_API_KEY=${curatorToken}`,
    "-e",
    `RAGNAROK_ADMIN_API_KEY=${adminToken}`,
    "-e",
    `RAGNAROK_TRUSTED_PROXIES=${bridgeGateway},127.0.0.1`,
    "-e",
    "RAGNAROK_ALLOWED_HOSTS=proxy.example",
    "-e",
    "RAGNAROK_HEALTHCHECK_HOST=proxy.example",
    "-e",
    "RAGNAROK_CORS_ORIGIN=https://ci.example",
    image,
  ]);
  const proxyHeaders = { "x-forwarded-proto": "https" };
  await ready(
    { protocol: "http", host: "proxy.example", headers: proxyHeaders },
    "shared trusted-proxy",
    proxyContainer,
  );
  await waitForHealth(proxyContainer);
  if ((await requestStatus({ pathname: "/health", protocol: "http", host: "proxy.example" })) !== 400) {
    throw new Error("Proxy-mode container accepted cleartext without verified X-Forwarded-Proto");
  }
  if (
    (await requestStatus({
      pathname: "/health",
      protocol: "http",
      host: "evil.example",
      headers: proxyHeaders,
    })) !== 403
  ) {
    throw new Error("Proxy-mode container accepted an unapproved Host");
  }
  await stopGracefully(proxyContainer);

  console.log(`Docker release gate passed (${imageBytes} bytes, ${imageArchitecture}).`);
} finally {
  for (const container of containers) {
    try {
      run("docker", ["rm", "-f", container]);
    } catch {}
  }
  try {
    run("docker", ["volume", "rm", volume]);
  } catch {}
  await rm(certificates, { recursive: true, force: true });
}
