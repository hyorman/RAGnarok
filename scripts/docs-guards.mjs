// Pure checks behind scripts/check-docs.mjs, kept apart so scripts/test-docs-guards.mjs can hold
// each one to fixture text. Nothing here reads a file.

/** Lines of a document, with a CRLF checkout's carriage returns removed so they never count toward a width. */
export function linesOf(text) {
  return text.split(/\r?\n/);
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
// East Asian Wide and Fullwidth ranges, and emoji: each takes two columns.
const WIDE =
  /^(?:\p{Extended_Pictographic}|[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}])/u;

/** Display columns: one per grapheme cluster (a base letter and its combining marks), two for a wide one. */
export function displayWidth(line) {
  let width = 0;
  for (const { segment } of segmenter.segment(line)) {
    width += WIDE.test(segment) ? 2 : 1;
  }
  return width;
}

/** A line wrapping cannot shorten: a table row (blockquoted or not), a heading, or a reference definition. */
function unwrappable(line) {
  return /^\s*(?:>\s*)*\|/.test(line) || /^#/.test(line) || /^\s{0,3}\[[^\]]+\]:\s/.test(line);
}

/**
 * The overflow is one unbreakable token: everything before the last space fits, and that last token is
 * a URL or path (it holds "/") or is itself wider than the print width. Prose a few columns over is not.
 */
function overflowIsOneToken(line, printWidth) {
  const trimmed = line.trimEnd();
  const lastSpace = trimmed.lastIndexOf(" ");
  const token = trimmed.slice(lastSpace + 1);
  const fits = displayWidth(trimmed.slice(0, Math.max(lastSpace, 0))) <= printWidth;
  return fits && (token.includes("/") || displayWidth(token) > printWidth);
}

/**
 * Every line wider than `printWidth` that wrapping could have fixed, as `{ line, width }` (1-based).
 * Fenced blocks (three or more backticks or tildes, closed only by the same character at least as
 * long) and indented code blocks are exempt, as is any line `unwrappable` names or whose overflow is a
 * single unbreakable token.
 */
export function overWidthLines(text, printWidth) {
  const offenders = [];
  let fence = null;
  let previousBlank = true;
  let inIndentedCode = false;
  for (const [index, line] of linesOf(text).entries()) {
    const blank = line.trim() === "";
    if (fence) {
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    } else if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
      fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)[1];
    } else {
      inIndentedCode = !blank && /^(?: {4}|\t)/.test(line) && (previousBlank || inIndentedCode);
      if (!inIndentedCode && !unwrappable(line)) {
        const width = displayWidth(line);
        if (width > printWidth && !overflowIsOneToken(line, printWidth)) offenders.push({ line: index + 1, width });
      }
    }
    previousBlank = blank;
  }
  return offenders;
}

/**
 * The sentences of a document. Prose is joined across its line breaks and split after `.`, `!` or `?`;
 * a blank line ends a paragraph, and every table row is a unit of its own, so text from two rows never
 * reads as one sentence.
 */
export function sentencesOf(text) {
  const units = [];
  let paragraph = [];
  const flush = () => {
    const joined = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (joined) units.push(...joined.split(/(?<=[.!?])\s/));
    paragraph = [];
  };
  for (const line of linesOf(text)) {
    if (/^\s*(?:>\s*)*\|/.test(line)) {
      flush();
      units.push(line.replace(/\s+/g, " ").trim());
    } else if (line.trim() === "") {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return units;
}

/** TypeScript source with its comments removed, so a name that appears only in a comment is not read as code. */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");
}

/** A TypeScript source file, whichever extension it uses (a .d.ts declaration is not source). */
export function isSourceFile(name) {
  return /\.[cm]?tsx?$/.test(name) && !/\.d\.[cm]?ts$/.test(name);
}

const REJECTION_VERBS =
  /\b(?:reject|refus|abort|error|invalid|crash)\w*|\bfail(?:s|ed|ing|ure)?\b|\bexit(?:s|ed|ing)?\s+(?:with\s+(?:(?:exit\s+)?(?:code|status)\s+)?[1-9]|[1-9]\b|non-?zero)/gi;
const NEGATION = /\b(?:no|not|never|nothing|neither|nor|cannot|without|rather than|instead of|as opposed to)\b|n't\b/i;
// "rejected by nothing", "refused nowhere": the negation follows the verb.
const NEGATED_AFTER = /^\w*\s+(?:by\s+(?:nothing|none|no\b)|nowhere\b|never\b)/i;
const CLAUSE_BREAK = /[,;:()]|\b(?:and|but|so|yet|then|while|whereas|because|although)\b/i;
const NEGATION_WINDOW_WORDS = 4;

/** True when a sentence claims something is rejected or errors: a rejection verb not negated in its own clause. */
export function claimsRejection(sentence) {
  return [...sentence.matchAll(REJECTION_VERBS)].some((verb) => {
    const clause = sentence.slice(0, verb.index).split(CLAUSE_BREAK).pop();
    const window = clause.trim().split(/\s+/).slice(-NEGATION_WINDOW_WORDS).join(" ");
    const after = sentence.slice(verb.index);
    return !NEGATION.test(window) && !NEGATED_AFTER.test(after);
  });
}

/** The sentence tests for the removed HTTP-transport variables, given their names. */
export function removedVariableGuard(removedVariables) {
  const namesOne = new RegExp(`\\b(?:${removedVariables.join("|")})\\b`);
  const about = (sentence) =>
    namesOne.test(sentence) ||
    /\b(?:removed|old|legacy|former)[- ](?:(?:HTTP|transport|environment|network)[- ])*(?:transport|variables?|listener)/i.test(
      sentence,
    ) ||
    (/\bnetwork listener\b/i.test(sentence) && /\b(?:variables?|settings?|removed|transport)\b/i.test(sentence));
  // A pointer ("They are rejected", "Setting one aborts ...") continues the previous sentence's subject,
  // except "setting one of the [up to three words] key(s)" or "setting one key": configuration keys.
  const pointer =
    /^(?:they|these|those|such|each|this|doing so|setting (?:one|any one|any of them))\b(?!\s+(?:of the\s+(?:[\w.-]+\s+){0,3}?keys?\b|keys?\b))/i;
  return {
    about,
    /** True when `sentence` says a removed variable is rejected or errors, directly or through a pointer. */
    flags(sentence, previous = "") {
      const continues = pointer.test(sentence) && about(previous);
      return (about(sentence) || continues) && claimsRejection(sentence);
    },
  };
}

/** A release-tooling variable no shipped source reads, and the one canonical doc allowed to name it. */
export const RELEASE_TOOLING_VARIABLES = new Map([["RAGNAROK_RELEASE_ARTIFACT_DIR", "docs/BENCHMARKS.md"]]);
