// GitHub's ubuntu runners ship Docker with the classic image store, which cannot `docker load` an
// OCI layout and re-encodes manifests on `docker push`. The release image pipeline needs the
// containerd image store (as Docker Desktop and Colima use), so the Docker jobs switch to it first.
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const DAEMON_CONFIG = "/etc/docker/daemon.json";
const CONTAINERD_DRIVER = "io.containerd.snapshotter.v1";
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 1_000;

export function withContainerdSnapshotter(config) {
  return { ...config, features: { ...config.features, "containerd-snapshotter": true } };
}

function readDaemonConfig() {
  // A missing file means Docker runs on its defaults.
  if (spawnSync("sudo", ["test", "-f", DAEMON_CONFIG]).status !== 0) return {};
  return JSON.parse(execFileSync("sudo", ["cat", DAEMON_CONFIG], { encoding: "utf8" }));
}

async function driverStatus() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      return execFileSync("docker", ["info", "--format", "{{json .DriverStatus}}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
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
