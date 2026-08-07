import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prettierOptions = (await prettier.resolveConfig(path.join(root, "package.json"))) ?? {};
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const models = JSON.parse(await readFile(path.join(root, "packages/core/assets/models/manifest.json"), "utf8"));

function packageNameFromLocation(location) {
  const suffix = location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length);
  const parts = suffix.split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

const packages = Object.entries(lock.packages)
  .filter(([location, pkg]) => location.includes("node_modules/") && pkg.version)
  .map(([location, pkg]) => ({
    name: packageNameFromLocation(location),
    version: pkg.version,
    location,
    integrity: pkg.integrity,
    resolved: pkg.resolved,
    license: pkg.license,
  }))
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));

const npmPurl = (name, version) => {
  const encodedName = name.startsWith("@")
    ? `%40${encodeURIComponent(name.slice(1).split("/")[0])}/${encodeURIComponent(name.split("/")[1])}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${version}`;
};
const npmBomRef = (location) => `urn:ragnarok:package-lock:${encodeURIComponent(location)}`;
const npmComponents = packages.map((pkg) => ({
  type: "library",
  "bom-ref": npmBomRef(pkg.location),
  name: pkg.name,
  version: pkg.version,
  purl: npmPurl(pkg.name, pkg.version),
  licenses: pkg.license ? [{ license: { id: pkg.license } }] : undefined,
  hashes: pkg.integrity?.startsWith("sha512-")
    ? [{ alg: "SHA-512", content: Buffer.from(pkg.integrity.slice(7), "base64").toString("hex") }]
    : undefined,
  externalReferences: pkg.resolved ? [{ type: "distribution", url: pkg.resolved }] : undefined,
  properties: [{ name: "ragnarok:package-lock:location", value: pkg.location }],
}));

const modelComponents = models.models.map((model) => {
  const artifacts = models.artifacts.filter((artifact) => artifact.model === model.id);
  return {
    type: "machine-learning-model",
    "bom-ref": `pkg:huggingface/${model.id}@${model.revision}`,
    name: model.id,
    version: model.revision,
    licenses: [{ license: { id: model.license } }],
    hashes: artifacts.map((artifact) => ({ alg: "SHA-256", content: artifact.sha256 })),
    externalReferences: [{ type: "distribution", url: `${model.source}/tree/${model.revision}` }],
    properties: artifacts.flatMap((artifact) => [
      { name: `ragnarok:model:${artifact.filename}:size`, value: String(artifact.size) },
      { name: `ragnarok:model:${artifact.filename}:sha256`, value: artifact.sha256 },
    ]),
  };
});

const serial = createHash("sha256")
  .update(JSON.stringify({ lock: lock.lockfileVersion, packages, models }))
  .digest("hex");
const cdx = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: `urn:uuid:${serial.slice(0, 8)}-${serial.slice(8, 12)}-4${serial.slice(13, 16)}-a${serial.slice(17, 20)}-${serial.slice(20, 32)}`,
  version: 1,
  metadata: {
    component: { type: "application", name: "ragnarok", version: lock.version },
    properties: [{ name: "ragnarok:container-base", value: "node:22-slim" }],
  },
  components: [...npmComponents, ...modelComponents],
};

const spdxPackages = [...npmComponents, ...modelComponents].map((component, index) => ({
  SPDXID: `SPDXRef-Package-${index + 1}`,
  name: component.name,
  versionInfo: component.version,
  downloadLocation: component.externalReferences?.[0]?.url ?? "NOASSERTION",
  filesAnalyzed: false,
  licenseConcluded: component.licenses?.[0]?.license?.id ?? "NOASSERTION",
  licenseDeclared: component.licenses?.[0]?.license?.id ?? "NOASSERTION",
  externalRefs: component.purl
    ? [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: component.purl }]
    : [],
}));
const spdx = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "ragnarok-sbom",
  documentNamespace: `https://github.com/hyorman/ragnarok/sbom/${serial}`,
  creationInfo: {
    created: "1970-01-01T00:00:00Z",
    creators: ["Tool: scripts/generate-sbom.mjs"],
  },
  packages: spdxPackages,
  relationships: spdxPackages.map((pkg) => ({
    spdxElementId: "SPDXRef-DOCUMENT",
    relationshipType: "DESCRIBES",
    relatedSpdxElement: pkg.SPDXID,
  })),
};

await writeFile(
  path.join(root, "bom.cdx.json"),
  await prettier.format(JSON.stringify(cdx), { ...prettierOptions, parser: "json" }),
);
await writeFile(
  path.join(root, "bom.spdx.json"),
  await prettier.format(JSON.stringify(spdx), { ...prettierOptions, parser: "json" }),
);
console.log(
  `Generated CycloneDX and SPDX inventories for ${packages.length} packages and ${models.models.length} models.`,
);
