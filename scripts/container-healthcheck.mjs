import { readFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

const normalize = (value) => String(value ?? "").trim().toLowerCase();

export function buildHealthcheckRequest(environment = process.env, readCertificate = readFileSync) {
  const port = Number(environment.RAGNAROK_PORT || 4000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Container health check requires a valid RAGNAROK_PORT");
  }
  const allowedHosts = new Set(
    String(environment.RAGNAROK_ALLOWED_HOSTS ?? "")
      .split(",")
      .map(normalize)
      .filter(Boolean),
  );
  const certPath = environment.RAGNAROK_TLS_CA_PATH || environment.RAGNAROK_TLS_CERT_PATH;
  const servername = normalize(environment.RAGNAROK_TLS_SERVER_NAME);
  if (certPath || servername) {
    if (!certPath || !servername || !allowedHosts.has(servername)) {
      throw new Error(
        "Native-TLS health check requires CA/certificate, TLS_SERVER_NAME, and that exact name in RAGNAROK_ALLOWED_HOSTS",
      );
    }
    return {
      protocol: "https",
      options: {
        hostname: "127.0.0.1",
        port,
        path: "/ready",
        ca: readCertificate(certPath),
        servername,
        headers: { host: servername },
        timeout: 4_000,
      },
    };
  }

  const healthHost = normalize(environment.RAGNAROK_HEALTHCHECK_HOST);
  const trustedProxies = new Set(
    String(environment.RAGNAROK_TRUSTED_PROXIES ?? "")
      .split(",")
      .map(normalize)
      .filter(Boolean),
  );
  if (!healthHost || !allowedHosts.has(healthHost) || !trustedProxies.has("127.0.0.1")) {
    throw new Error(
      "Proxy-mode health check requires RAGNAROK_HEALTHCHECK_HOST in RAGNAROK_ALLOWED_HOSTS and 127.0.0.1 in RAGNAROK_TRUSTED_PROXIES",
    );
  }
  return {
    protocol: "http",
    options: {
      hostname: "127.0.0.1",
      port,
      path: "/ready",
      headers: { host: healthHost, "x-forwarded-proto": "https" },
      timeout: 4_000,
    },
  };
}

export function main(environment = process.env) {
  let requestConfiguration;
  try {
    requestConfiguration = buildHealthcheckRequest(environment);
  } catch {
    process.exitCode = 1;
    return;
  }
  const request = (requestConfiguration.protocol === "https" ? httpsGet : httpGet)(
    requestConfiguration.options,
    (response) => {
      response.resume();
      process.exitCode = response.statusCode === 200 ? 0 : 1;
    },
  );
  request.on("timeout", () => request.destroy(new Error("Readiness request timed out")));
  request.on("error", () => {
    process.exitCode = 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
