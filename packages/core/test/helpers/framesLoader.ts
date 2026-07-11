import * as fs from "fs";
import * as fsp from "fs/promises";
import * as https from "https";
import * as path from "path";
import * as readline from "readline";

const FRAMES_TSV_URL = "https://huggingface.co/datasets/google/frames-benchmark/resolve/main/test.tsv";

export interface FramesEntry {
  id: number;
  prompt: string;
  answer: string;
  wikiLinks: string[];
  reasoningTypes: string[];
}

function httpsGet(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (requestUrl: string) => {
      https
        .get(requestUrl, (res) => {
          if (
            (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) &&
            res.headers.location
          ) {
            res.resume();
            const location = res.headers.location!;
            // Resolve relative redirects against the current URL
            const resolved = location.startsWith("http") ? location : new URL(location, requestUrl).toString();
            request(resolved);
            return;
          }
          if (res.statusCode !== 200) {
            file.close();
            reject(new Error(`Download failed with status ${res.statusCode}`));
            return;
          }
          res.pipe(file);
          file.on("finish", () => file.close(() => resolve()));
          file.on("error", (err) => {
            file.close();
            reject(err);
          });
        })
        .on("error", (err) => {
          file.close();
          reject(err);
        });
    };
    request(url);
  });
}

export async function downloadFrames(cacheDir: string): Promise<string> {
  const tsvPath = path.join(cacheDir, "frames-test.tsv");

  if (
    await fsp
      .access(tsvPath)
      .then(() => true)
      .catch(() => false)
  ) {
    return tsvPath;
  }

  await fsp.mkdir(cacheDir, { recursive: true });
  await httpsGet(FRAMES_TSV_URL, tsvPath);

  return tsvPath;
}

export async function loadFramesEntries(tsvPath: string): Promise<FramesEntry[]> {
  const entries: FramesEntry[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(tsvPath),
    crlfDelay: Infinity,
  });

  let header = true;
  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    if (header) {
      header = false;
      continue;
    }

    const cols = line.split("\t");
    const id = Number(cols[0]);
    const prompt = cols[1] ?? "";
    const answer = cols[2] ?? "";
    const reasoningTypesRaw = cols[14] ?? "";
    const wikiLinksRaw = cols[15] ?? "";

    let wikiLinks: string[] = [];
    if (wikiLinksRaw.trim()) {
      try {
        // The TSV uses Python list syntax with single quotes — convert to JSON
        const jsonish = wikiLinksRaw.replace(/'/g, '"');
        const parsed = JSON.parse(jsonish);
        if (Array.isArray(parsed)) {
          wikiLinks = parsed.filter((v: unknown) => typeof v === "string" && v.length > 0);
        }
      } catch {
        // malformed JSON — leave wikiLinks empty
      }
    }

    const reasoningTypes = reasoningTypesRaw
      .split(" | ")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    entries.push({ id, prompt, answer, wikiLinks, reasoningTypes });
  }

  return entries;
}

function normalizeWikiUrl(raw: string): string {
  let u = raw.trim();
  if (!u.startsWith("http")) {
    u = "https://" + u;
  }
  u = u.replace("//en.m.wikipedia.org/", "//en.wikipedia.org/");
  return u;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWikipediaArticle(
  url: string,
  cacheDir: string,
): Promise<{ title: string; text: string } | null> {
  const normalized = normalizeWikiUrl(url);
  const match = normalized.match(/\/wiki\/(.+)$/);
  if (!match) {
    return null;
  }
  const title = decodeURIComponent(match[1]);
  const safeFilename = title.replace(/[/\\?%*:|"<>]/g, "_");
  const cachePath = path.join(cacheDir, `${safeFilename}.json`);

  if (
    await fsp
      .access(cachePath)
      .then(() => true)
      .catch(() => false)
  ) {
    const cached = JSON.parse(await fsp.readFile(cachePath, "utf-8"));
    return cached as { title: string; text: string };
  }

  await fsp.mkdir(cacheDir, { recursive: true });

  const apiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const json = await new Promise<string>((resolve, reject) => {
        const request = (requestUrl: string) => {
          https
            .get(requestUrl, { headers: { "User-Agent": "CopilotRAG/1.0" } }, (res) => {
              if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                res.resume();
                request(res.headers.location);
                return;
              }
              if (res.statusCode === 429) {
                res.resume();
                reject(new Error("RATE_LIMITED"));
                return;
              }
              if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Wikipedia API returned status ${res.statusCode}`));
                return;
              }
              const chunks: Buffer[] = [];
              res.on("data", (chunk: Buffer) => chunks.push(chunk));
              res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
              res.on("error", reject);
            })
            .on("error", reject);
        };
        request(apiUrl);
      });

      const data = JSON.parse(json) as { title?: string; extract?: string };
      const result = {
        title: data.title ?? title,
        text: data.extract ?? "",
      };

      await fsp.writeFile(cachePath, JSON.stringify(result), "utf-8");
      return result;
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "RATE_LIMITED" && attempt < MAX_RETRIES) {
        const backoff = (attempt + 1) * 1000; // 1s, 2s, 3s
        await delay(backoff);
        continue;
      }
      return null;
    }
  }
  return null;
}
