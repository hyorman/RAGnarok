import { strict as assert } from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  FILE_KEYS,
  buildDefaultsBlock,
  ensureConfigFile,
  readConfigFile,
  CONFIG_FILE_NAME,
} from "../src/configFile";
import { loadConfig } from "../src/config";
import { STORAGE_CONFIG_FILENAME } from "@ragnarok/core";

describe("config file key table", () => {
  it("declares exactly the 23 keys that move to the file", () => {
    assert.equal(FILE_KEYS.length, 23);
  });

  it("names the same file core exempts from storage-format gating and reset backups", () => {
    // ensureConfigFile writes into the storage directory before core validates
    // the storage format. Core's isInfrastructureEntry must recognise that name,
    // or a fresh install reads as unversioned v0.3 storage and refuses to start.
    assert.equal(CONFIG_FILE_NAME, STORAGE_CONFIG_FILENAME);
  });

  it("maps every key to a distinct McpConfig field", () => {
    const fields = FILE_KEYS.map((k) => k.field);
    assert.equal(new Set(fields).size, fields.length, "duplicate McpConfig field in FILE_KEYS");
  });

  it("names no env-only setting", () => {
    const forbidden = ["storageDir", "workingDir", "llmApiKey", "embeddingApiKey", "githubToken", "resetStorage"];
    for (const field of FILE_KEYS.map((k) => k.field)) {
      assert.ok(!forbidden.includes(field), `${field} is env-only and must not be a config key`);
    }
  });

  it("builds a defaults block covering every key, with exportDir shown as a storage-relative literal", () => {
    const block = buildDefaultsBlock() as Record<string, Record<string, unknown>>;
    for (const key of FILE_KEYS) {
      const [section, name] = key.path;
      assert.ok(section in block, `missing section ${section}`);
      assert.ok(name in block[section], `missing ${section}.${name}`);
    }
    assert.equal(block.storage.exportDir, "<storageDir>/exports");
  });
});

describe("reading the config file", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-cfg-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (value: unknown) =>
    fs.writeFileSync(
      path.join(dir, CONFIG_FILE_NAME),
      typeof value === "string" ? value : JSON.stringify(value),
    );

  it("returns no values when the file is absent", () => {
    assert.deepEqual(readConfigFile(dir), {});
  });

  it("returns no values when the storage directory does not exist", () => {
    assert.deepEqual(readConfigFile(path.join(dir, "nope")), {});
  });

  it("throws naming the path when config.json exists but cannot be read", () => {
    const filePath = path.join(dir, CONFIG_FILE_NAME);
    // A directory at the config.json path makes readFileSync fail on every platform
    // (EISDIR), with no dependence on chmod semantics - chmod cannot remove read
    // permission on Windows, so a 0o000 file would still read fine there.
    fs.mkdirSync(filePath);
    assert.throws(
      () => readConfigFile(dir),
      // "Cannot read ..." pins this to the read-error branch rather than the JSON
      // parse branch. The errno itself is left unasserted: it is EISDIR on POSIX,
      // but the exact code is not worth depending on across platforms.
      (e: unknown) => e instanceof Error && e.message.startsWith("Cannot read") && e.message.includes(filePath),
    );
  });

  it("flattens nested keys onto McpConfig fields", () => {
    write({ retrieval: { topK: 42 }, ingestion: { chunkSize: 500 } });
    const values = readConfigFile(dir);
    assert.equal(values.topK, 42);
    assert.equal(values.chunkSize, 500);
  });

  it("ignores comment keys at both levels", () => {
    write({ "//": "note", $defaults: { retrieval: { topK: 9999 } }, retrieval: { topK: 7 } });
    assert.equal(readConfigFile(dir).topK, 7);
  });

  it("ignores comment keys nested inside a section", () => {
    write({ retrieval: { "//": "how many chunks to retrieve", $note: "ignored", topK: 7 } });
    assert.equal(readConfigFile(dir).topK, 7);
  });

  it("never takes a value from $defaults", () => {
    write({ $defaults: { retrieval: { topK: 9999 } } });
    assert.equal(readConfigFile(dir).topK, undefined);
  });

  it("throws naming the file on malformed JSON", () => {
    write("{ not json");
    assert.throws(
      () => readConfigFile(dir),
      (e: unknown) => e instanceof Error && e.message.includes(CONFIG_FILE_NAME),
    );
  });

  it("throws naming an unknown key", () => {
    write({ retrieval: { topKk: 5 } });
    assert.throws(() => readConfigFile(dir), /topKk/);
  });

  it("throws naming an unknown section", () => {
    write({ nonsense: { a: 1 } });
    assert.throws(() => readConfigFile(dir), /nonsense/);
  });

  it("throws on a wrong type", () => {
    write({ retrieval: { topK: "ten" } });
    assert.throws(() => readConfigFile(dir), /topK/);
  });

  for (const [section, name] of [
    ["storage", "storageDir"],
    ["llm", "apiKey"],
    ["embedding", "apiKey"],
    ["security", "githubToken"],
  ] as const) {
    it(`rejects env-only setting ${section}.${name} and says it is environment-only`, () => {
      write({ [section]: { [name]: "x" } });
      assert.throws(() => readConfigFile(dir), /environment-only/i);
    });
  }
});

describe("generating the config file", () => {
  let dir: string;
  const noop = () => {};
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-gen-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE_NAME), "utf8"));

  it("creates the file with an empty live section and a full $defaults block", () => {
    ensureConfigFile(dir, noop);
    const written = read();
    assert.deepEqual(written.$defaults, buildDefaultsBlock());
    assert.ok(written.$envOnly, "must document the env-only settings");
    for (const key of FILE_KEYS) {
      assert.equal(written[key.path[0]], undefined, `${key.path[0]} must not be live on generation`);
    }
  });

  it("generates a file that reads back as no values", () => {
    ensureConfigFile(dir, noop);
    assert.deepEqual(readConfigFile(dir), {});
  });

  it("is a no-op when the file already exists", () => {
    fs.writeFileSync(path.join(dir, CONFIG_FILE_NAME), JSON.stringify({ retrieval: { topK: 5 } }));
    ensureConfigFile(dir, noop);
    assert.equal(read().retrieval.topK, 5);
  });

  it("refreshes a stale $defaults block without touching user keys", () => {
    fs.writeFileSync(
      path.join(dir, CONFIG_FILE_NAME),
      JSON.stringify({ "//": "mine", $defaults: { retrieval: { topK: 3 } }, retrieval: { topK: 5 } }),
    );
    ensureConfigFile(dir, noop);
    const written = read();
    assert.deepEqual(written.$defaults, buildDefaultsBlock(), "$defaults must be refreshed");
    assert.equal(written.retrieval.topK, 5, "user key must survive byte-identical");
    assert.equal(written["//"], "mine", "comment key must survive");
  });

  it("does not overwrite a malformed file", () => {
    const filePath = path.join(dir, CONFIG_FILE_NAME);
    fs.writeFileSync(filePath, "{ not json");
    ensureConfigFile(dir, noop);
    assert.equal(fs.readFileSync(filePath, "utf8"), "{ not json");
  });

  it("warns and continues when the directory is not writable", () => {
    const messages: string[] = [];
    ensureConfigFile(path.join(dir, "does", "not", "exist"), (m) => messages.push(m));
    assert.equal(messages.length, 1, "must warn exactly once");
  });
});

describe("$defaults accuracy", () => {
  // The generated file documents a default for every key. Nothing else compares
  // FILE_KEYS.shown against what loadConfig() actually produces, so without this
  // guard the two drift apart silently and the generated documentation lies.
  const saved: Record<string, string | undefined> = {};
  let tmpStorage: string;

  beforeEach(() => {
    // Scrub by prefix rather than by a fixed list: a variable added later must
    // not be able to leak into the comparison just because no one updated a list.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("RAGNAROK_") || key === "GITHUB_ACCESS_TOKEN") {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    }
    // loadConfig() reads config.json from the storage directory. Without one of
    // our own it resolves to the developer's real ~/.ragnarok and compares
    // against their personal settings instead of the built-in defaults.
    tmpStorage = fs.mkdtempSync(path.join(os.tmpdir(), "ragnarok-defaults-"));
    process.env.RAGNAROK_STORAGE_DIR = tmpStorage;
  });

  afterEach(() => {
    delete process.env.RAGNAROK_STORAGE_DIR;
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
      delete saved[key];
    }
    fs.rmSync(tmpStorage, { recursive: true, force: true });
  });

  it("shows, for every key, the value loadConfig() actually defaults to", () => {
    const block = buildDefaultsBlock() as Record<string, Record<string, unknown>>;
    const config = loadConfig();
    for (const key of FILE_KEYS) {
      const [section, name] = key.path;
      // exportDir is the one deliberate exception: its default is derived from
      // the storage directory, so $defaults shows a literal placeholder. The
      // test below pins that the placeholder still describes the real default.
      if (key.field === "exportDir") {
        continue;
      }
      assert.deepEqual(
        block[section][name],
        config[key.field],
        `$defaults shows ${section}.${name} = ${JSON.stringify(block[section][name])}, ` +
          `but loadConfig() defaults ${key.field} to ${JSON.stringify(config[key.field])}`,
      );
    }
  });

  it("documents exportDir as a placeholder because its default is storage-relative", () => {
    assert.equal(loadConfig().exportDir, path.join(tmpStorage, "exports"));
  });
});
