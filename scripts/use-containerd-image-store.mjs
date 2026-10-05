// Switches a GitHub Actions Linux runner's Docker daemon to the containerd image store, for the jobs
// that build, load or push the release image as an OCI archive.
//
// Why: the runners ship the classic image store. Its `docker` buildx driver cannot export OCI, its
// `docker load` needs a manifest.json that an OCI layout lacks, and `docker push` re-encodes
// manifests, so the pushed digest would differ from the archived one. Docker Desktop and Colima
// already use the containerd store, which the release pipeline was developed on.
//
// What it does: merges `features.containerd-snapshotter: true` into /etc/docker/daemon.json, keeping
// every other setting (an empty file counts as none), restarts Docker, polls `docker info` (each call
// timed out on its own) for up to 30 s, and fails unless the io.containerd.snapshotter.v1 driver is
// active.
//
// Safety: it rewrites a system file and restarts a daemon, so it refuses to run anywhere but a GitHub
// Actions Linux runner. The release static tests import only its pure helpers.
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const DAEMON_CONFIG = "/etc/docker/daemon.json";
const CONTAINERD_DRIVER = "io.containerd.snapshotter.v1";
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 1_000;
// A daemon still restarting can hold `docker info` open; each call gives up so the poll keeps its deadline.
const DOCKER_INFO_TIMEOUT_MS = 5_000;

export function withContainerdSnapshotter(config) {
  return { ...config, features: { ...config.features, "containerd-snapshotter": true } };
}

/** The daemon config's settings. An empty file is no settings; anything but a JSON object is refused. */
export function parseDaemonConfig(text) {
  if (text.trim() === "") return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${DAEMON_CONFIG} must hold a JSON object; refusing to rewrite it`);
  }
  return parsed;
}

function readDaemonConfig() {
  // A missing file means Docker runs on its defaults.
  if (spawnSync("sudo", ["test", "-f", DAEMON_CONFIG]).status !== 0) return {};
  return parseDaemonConfig(execFileSync("sudo", ["cat", DAEMON_CONFIG], { encoding: "utf8" }));
}

async function driverStatus() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      return execFileSync("docker", ["info", "--format", "{{json .DriverStatus}}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: DOCKER_INFO_TIMEOUT_MS,
      });
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await sleep(READY_POLL_MS);
    }
  }
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "linux") {
    throw new Error(
      "use-containerd-image-store.mjs rewrites the Docker daemon config and only runs on a GitHub Actions Linux runner",
    );
  }
  const merged = withContainerdSnapshotter(readDaemonConfig());
  execFileSync("sudo", ["tee", DAEMON_CONFIG], {
    input: `${JSON.stringify(merged, null, 2)}\n`,
    stdio: ["pipe", "ignore", "inherit"],
  });
  execFileSync("sudo", ["systemctl", "restart", "docker"], { stdio: "inherit" });
  const status = await driverStatus();
  if (!status.includes(CONTAINERD_DRIVER)) throw new Error(`containerd image store is not active: ${status.trim()}`);
  console.log("Docker now uses the containerd image store.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
