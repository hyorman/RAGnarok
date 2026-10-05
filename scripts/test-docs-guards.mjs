// Fixture checks for the docs-gate guards in docs-guards.mjs. Each case is a sentence or a line the
// gate must flag, or must let through, so a change to a guard shows here before it shows on the docs.
import assert from "node:assert/strict";
import {
  claimsRejection,
  displayWidth,
  fencedBlockUnder,
  isSourceFile,
  overWidthLines,
  removedVariableGuard,
  sentencesOf,
  stripComments,
} from "./docs-guards.mjs";

const guard = removedVariableGuard(["RAGNAROK_PORT", "RAGNAROK_DEPLOYMENT_MODE"]);
const flagged = (sentence, previous) => guard.flags(sentence, previous);

// Claims of a rejection the server does not make: each must be flagged.
for (const sentence of [
  "Setting RAGNAROK_PORT makes the server exit with an error.",
  "RAGNAROK_PORT is refused at startup.",
  "If RAGNAROK_DEPLOYMENT_MODE is set, the server fails to start.",
  "A removed variable such as RAGNAROK_PORT aborts the process.",
  "The legacy HTTP transport variables are rejected at startup.",
  "The old transport variables are rejected at startup.",
  "RAGNAROK_PORT makes the server exit with status 1.",
  "RAGNAROK_PORT makes the server exit with exit code 1.",
  "RAGNAROK_PORT makes the server exit with code 1.",
  "Former transport variables make the server exit 1.",
  // A negation in another clause (a comma splice) does not cover "rejected".
  "Nothing changes, RAGNAROK_PORT is rejected.",
  "RAGNAROK_PORT is not read (it is rejected).",
  "RAGNAROK_PORT is not read while it is rejected.",
  "RAGNAROK_PORT is not read because it is rejected.",
  // A negation outside the four words before the verb does not cover it.
  "Without a restart nothing changes for RAGNAROK_PORT which is rejected outright.",
  "RAGNAROK_PORT is rejected, not ignored.",
  "RAGNAROK_PORT is rejected with no warning.",
]) {
  assert.ok(flagged(sentence), `must flag: ${sentence}`);
}
// A pointer sentence continues the one before it.
assert.ok(flagged("They are rejected at startup.", "RAGNAROK_PORT is no longer read."));
assert.ok(
  flagged("Setting any one of the three aborts the process before the API key is read.", "RAGNAROK_PORT is removed."),
  "a 'key' later in the sentence does not make a pointer about configuration keys",
);

// True statements: none may be flagged.
for (const sentence of [
  "RAGNAROK_PORT is not rejected; it is ignored.",
  "Removed transport variables are not read, so they are not rejected.",
  "Nothing rejects RAGNAROK_PORT.",
  "RAGNAROK_PORT is ignored rather than rejected.",
  "RAGNAROK_PORT is rejected by nothing.",
  "RAGNAROK_PORT is refused nowhere.",
  "Setting RAGNAROK_PORT does nothing, and the server exits when the client closes stdin.",
  "Setting RAGNAROK_PORT changes nothing; the server terminates normally on stdin EOF.",
  "The legacy storage layout is refused at startup.",
]) {
  assert.ok(!flagged(sentence), `must not flag: ${sentence}`);
}
assert.ok(
  !flagged("Setting one of the keys aborts startup when its value is invalid.", "RAGNAROK_PORT is no longer read."),
  "'setting one of the keys' is about configuration keys",
);
assert.ok(
  !flagged("RAGNAROK_PORT is no thing the server rejected."),
  "a negation inside the four-word window covers the verb",
);
assert.ok(
  flagged("RAGNAROK_PORT has no meaning to the server which rejected it."),
  "a negation five words before the verb does not cover it",
);
assert.ok(
  !flagged("They are rejected.", "The config file is read once."),
  "a pointer needs a previous removed-variable sentence",
);
assert.ok(
  !flagged("They are rejected.", "The config file is read once."),
  "a pointer needs a previous removed-variable sentence",
);
assert.equal(claimsRejection("The process exits."), false, "a bare exit is lifecycle, not a rejection");
assert.equal(claimsRejection("The process exits non-zero."), true);
assert.equal(claimsRejection("The process exits with status 1."), true);
assert.equal(claimsRejection("The process exits with exit code 1."), true);
assert.equal(claimsRejection("The process exits with code 1."), true);

// Sentences: table rows stand alone, a blank line ends a paragraph, CRLF is a line break.
assert.deepEqual(sentencesOf("| a | RAGNAROK_PORT |\n| b | fails on bad JSON |"), [
  "| a | RAGNAROK_PORT |",
  "| b | fails on bad JSON |",
]);
assert.deepEqual(sentencesOf("> | quoted | row |\r\nOne. Two\r\nthree.\r\n\r\nFour"), [
  "> | quoted | row |",
  "One.",
  "Two three.",
  "Four",
]);
assert.deepEqual(sentencesOf("RAGNAROK_PORT removed\n\nIt fails on bad JSON."), [
  "RAGNAROK_PORT removed",
  "It fails on bad JSON.",
]);
assert.ok(
  !sentencesOf("| RAGNAROK_PORT | removed |\n| config.json | fails on bad JSON |").some((unit) => flagged(unit)),
  "a removed variable in one row and a failure in the next are not one claim",
);

// Width: display columns, every offender, and only lines that wrapping could fix.
assert.equal(displayWidth("é"), 1, "a combining accent adds no column");
assert.equal(displayWidth("表"), 2, "a wide character takes two columns");
const words = (count) => "word ".repeat(count).trimEnd();
assert.deepEqual(overWidthLines(`${words(5)}\r\n${words(30)}\n${words(31)}`, 120), [
  { line: 2, width: 149 },
  { line: 3, width: 154 },
]);
assert.deepEqual(overWidthLines(`${words(24)}\r\n`, 120), [], "a CRLF ending adds no column");
assert.deepEqual(overWidthLines(`${words(30)}\r\n`, 120), [{ line: 1, width: 149 }], "CRLF is not counted");
// One-token exemption: only a URL, a path or an overlong word, never prose a few columns over.
assert.deepEqual(
  overWidthLines(`${words(24)} abcdef`, 120),
  [{ line: 1, width: 126 }],
  "prose a little over is reported",
);
assert.deepEqual(
  overWidthLines(`${words(23)} see docs/some/long/path.md`, 120),
  [],
  "a path ending the line is exempt",
);
assert.deepEqual(overWidthLines(`${words(23)} see https://a.b/c`, 120), [], "a URL ending the line is exempt");
assert.deepEqual(overWidthLines(`${words(23)} ${"x".repeat(125)}`, 120), [], "an overlong word is exempt");
assert.deepEqual(overWidthLines("表".repeat(61), 120), [], "one unbreakable token");
assert.deepEqual(overWidthLines(`${"表 ".repeat(60)}x`, 120), [{ line: 1, width: 181 }]);
for (const exempt of [
  `See https://example.com/${"a".repeat(120)}`,
  `[ref]: https://example.com/${"a".repeat(120)} "Title"`,
  `> | ${words(30)} |`,
  `| ${words(30)} |`,
  `# ${words(30)}`,
  `~~~\n${words(30)}\n~~~`,
  `${"`".repeat(4)}md\n${"`".repeat(3)}\n${words(30)}\n${"`".repeat(3)}\n${"`".repeat(4)}`,
  `Text.\n\n    ${words(30)}`,
]) {
  assert.deepEqual(overWidthLines(exempt, 120), [], `exempt: ${exempt.slice(0, 30)}`);
}
assert.deepEqual(
  overWidthLines(`~~~\ncode\n~~~\n${words(30)}`, 120),
  [{ line: 4, width: 149 }],
  "a ~~~ fence closes, and prose after it is checked",
);
assert.deepEqual(
  overWidthLines(`${"`".repeat(3)}\n~~~\n${words(30)}\n~~~\n${"`".repeat(3)}`, 120),
  [],
  "a backtick fence is not closed by tildes",
);
assert.deepEqual(
  overWidthLines(`~~~\n${"`".repeat(3)}\n${words(30)}\n${"`".repeat(3)}\n~~~`, 120),
  [],
  "a tilde fence is not closed by backticks",
);
assert.deepEqual(
  overWidthLines(`- item\n    ${words(30)}`, 120),
  [{ line: 2, width: 153 }],
  "an indented continuation with no blank line before it is prose",
);

// Source scanning.
assert.equal(
  stripComments('// RAGNAROK_OLD\nconst x = process.env.RAGNAROK_NEW; /* RAGNAROK_GONE */ const u = "https://a.b";'),
  '\nconst x = process.env.RAGNAROK_NEW;  const u = "https://a.b";',
);
for (const name of ["a.ts", "view.tsx", "a.mts", "a.cts"]) assert.equal(isSourceFile(name), true, name);
for (const name of ["a.d.ts", "a.js", "a.json"]) assert.equal(isSourceFile(name), false, name);

// The fenced block under a heading, and only that section's.
const guide = "### Build & Test Commands\n\n```bash\nnpm run compile\n```\n\n### Other\n\nnpm run tools:manifest\n";
assert.equal(fencedBlockUnder(guide, "### Build & Test Commands"), "npm run compile\n");
assert.equal(fencedBlockUnder(guide, "### Missing"), undefined);
assert.equal(
  fencedBlockUnder("### Build & Test Commands\n\nprose\n\n### Next\n\n```\nx\n```\n", "### Build & Test Commands"),
  undefined,
  "a block under the next heading is not this section's",
);

console.log("Docs-gate guard fixtures passed.");
