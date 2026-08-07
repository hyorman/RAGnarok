import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "benchmarks/corpus-manifest.json"), "utf8"));
const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");
const readIfValid = async (relative, expected) => {
  try {
    const contents = await readFile(path.join(root, relative));
    return sha256(contents) === expected;
  } catch {
    return false;
  }
};
const download = async (url) => {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
    headers: { "user-agent": "RAGnarok-release-benchmark/0.4" },
  });
  if (!response.ok) throw new Error(`Benchmark download ${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

const beir = manifest.corpora.find((corpus) => corpus.id === "beir-scifact-test");
const beirFiles = Object.entries(beir.files);
const beirReady = (
  await Promise.all(beirFiles.map(([relative, expected]) => readIfValid(`.cache/beir/scifact/${relative}`, expected)))
).every(Boolean);
if (!beirReady) {
  const archive = new AdmZip(await download(beir.source));
  for (const [relative, expected] of beirFiles) {
    const entryName = `scifact/${relative}`;
    const entry = archive.getEntry(entryName);
    if (!entry || entry.isDirectory) throw new Error(`SciFact archive omitted ${entryName}`);
    const contents = entry.getData();
    if (sha256(contents) !== expected) throw new Error(`SciFact checksum mismatch for ${relative}`);
    const destination = path.join(root, ".cache/beir/scifact", relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
}

const frames = manifest.corpora.find((corpus) => corpus.id === "google-frames-test");
const framesRelative = ".cache/frames/frames-test.tsv";
if (!(await readIfValid(framesRelative, frames.sha256))) {
  const contents = await download(frames.source);
  if (sha256(contents) !== frames.sha256) throw new Error("FRAMES TSV checksum mismatch");
  await mkdir(path.dirname(path.join(root, framesRelative)), { recursive: true });
  await writeFile(path.join(root, framesRelative), contents);
}

const frameLines = (await readFile(path.join(root, framesRelative), "utf8"))
  .split(/\r?\n/)
  .slice(1)
  .filter((line) => line.trim());
const eligibleLinks = [];
for (const line of frameLines) {
  try {
    const links = JSON.parse((line.split("\t")[15] ?? "").replace(/'/g, '"')).filter(
      (value) => typeof value === "string" && value.length > 0,
    );
    if (links.length > 0) eligibleLinks.push(links);
  } catch {
    // Match the benchmark loader: malformed link fields are ineligible.
  }
}
const step = Math.max(1, Math.floor(eligibleLinks.length / manifest.config.framesSampleSize));
const sampled = [];
for (let index = 0; index < eligibleLinks.length && sampled.length < manifest.config.framesSampleSize; index += step) {
  sampled.push(eligibleLinks[index]);
}
const urls = [...new Set(sampled.flat())];
const articleDigests = [];
for (const rawUrl of urls) {
  let normalized = rawUrl.trim();
  if (!normalized.startsWith("http")) normalized = `https://${normalized}`;
  normalized = normalized.replace("//en.m.wikipedia.org/", "//en.wikipedia.org/");
  const titleMatch = normalized.match(/\/wiki\/(.+)$/);
  if (!titleMatch) continue;
  const title = decodeURIComponent(titleMatch[1]);
  const filename = `${title.replace(/[/\\?%*:|"<>]/g, "_")}.json`;
  const destination = path.join(root, ".cache/frames/articles", filename);
  let contents;
  try {
    contents = await readFile(destination);
  } catch {
    const response = await download(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    const parsed = JSON.parse(response.toString("utf8"));
    contents = Buffer.from(JSON.stringify({ title: parsed.title ?? title, text: parsed.extract ?? "" }));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  articleDigests.push([`articles/${filename}`, sha256(contents)]);
}
articleDigests.sort(([left], [right]) => left.localeCompare(right));
const articleSetSha256 = sha256(`${articleDigests.map((row) => row.join("\0")).join("\n")}\n`);
if (articleDigests.length !== frames.sampleArticleCount || articleSetSha256 !== frames.sampleArticlesSha256) {
  throw new Error(
    "FRAMES article acquisition does not match the pinned sample. Do not update checksums without reviewed source evidence.",
  );
}

console.log(
  `Pinned benchmark corpora ready: SciFact ${beirFiles.length} files, FRAMES ${articleDigests.length} articles.`,
);
