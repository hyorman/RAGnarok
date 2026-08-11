import { strict as assert } from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FILE_KEYS, buildDefaultsBlock, readConfigFile, CONFIG_FILE_NAME } from "../src/configFile";

describe("config file key table", () => {
  it("declares exactly the 23 keys that move to the file", () => {
    assert.equal(FILE_KEYS.length, 23);
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
    const block = buildDefaultsBlock("/tmp/store") as Record<string, Record<string, unknown>>;
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
