import * as fs from "fs";
import * as fsp from "fs/promises";
import * as https from "https";
import * as path from "path";
import * as readline from "readline";
import AdmZip from "adm-zip";

const BEIR_BASE_URL = "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets";

function httpsGet(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (requestUrl: string) => {
      https
        .get(requestUrl, (res) => {
          if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
            res.resume();
            request(res.headers.location);
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

export async function downloadAndExtract(dataset: string, cacheDir: string): Promise<string> {
  const datasetDir = path.join(cacheDir, dataset);
  const corpusPath = path.join(datasetDir, "corpus.jsonl");

  if (
    await fsp
      .access(corpusPath)
      .then(() => true)
      .catch(() => false)
  ) {
    return datasetDir;
  }

  if (process.env.RAGNAROK_BENCHMARK_MODE === "release") {
    throw new Error(
      `Release benchmark corpus is missing at ${datasetDir}. ` +
        "Run the documented benchmark acquisition command before the release gate; release mode never downloads or skips.",
    );
  }

  await fsp.mkdir(cacheDir, { recursive: true });

  const zipPath = path.join(cacheDir, `${dataset}.zip`);
  await httpsGet(`${BEIR_BASE_URL}/${dataset}.zip`, zipPath);

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(cacheDir, true);

  await fsp.unlink(zipPath);

  return datasetDir;
}

export async function loadCorpus(dir: string): Promise<Map<string, { title: string; text: string }>> {
  const result = new Map<string, { title: string; text: string }>();
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(dir, "corpus.jsonl")),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    const obj = JSON.parse(line) as {
      _id: string;
      title: string;
      text: string;
    };
    result.set(obj._id, { title: obj.title, text: obj.text });
  }
  return result;
}

export async function loadQueries(dir: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(dir, "queries.jsonl")),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    const obj = JSON.parse(line) as { _id: string; text: string };
    result.set(obj._id, obj.text);
  }
  return result;
}

export async function loadQrels(dir: string, split?: string): Promise<Map<string, Map<string, number>>> {
  const result = new Map<string, Map<string, number>>();
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(dir, "qrels", split || "test") + ".tsv"),
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
    const [queryId, docId, scoreStr] = line.split("\t");
    let perQuery = result.get(queryId);
    if (!perQuery) {
      perQuery = new Map<string, number>();
      result.set(queryId, perQuery);
    }
    perQuery.set(docId, Number(scoreStr));
  }
  return result;
}
