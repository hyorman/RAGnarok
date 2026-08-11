import { strict as assert } from "assert";
import { FILE_KEYS, buildDefaultsBlock } from "../src/configFile";

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
