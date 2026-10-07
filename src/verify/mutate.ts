import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyFile, languageOf } from "../classify.js";
import { isTrivialLine } from "../symbols.js";
import { candidateTests, type RepoReader } from "../testMap.js";
import type { ChangedFile, Language, ParsedPatch } from "../types.js";
import { parsePatch } from "../diff.js";
import { runnerLanguageOf, type RunnerLanguage, type TestRunner } from "./runner.js";

export interface Mutant {
  path: string;
  line: number;
  /** e.g. "`>` → `>=`" */
  description: string;
  original: string;
  mutated: string;
}

export interface MutantResult extends Mutant {
  /** killed: a test failed (good). survived: every test still passed (a gap). invalid: the change broke the code itself. */
  status: "killed" | "survived" | "invalid" | "timeout";
  tests: string[];
}

export interface MutationReport {
  results: MutantResult[];
  /** Files skipped, with the reason (no tests, tests already failing, no runner...). */
  skipped: { path: string; reason: string }[];
  /** True when the time budget ran out before every mutant was tried. */
  truncated: boolean;
}

/**
 * Replace string literals and comments with spaces (keeping positions), so operators inside them
 * are never mutated. Template-literal `${}` contents are masked too, which is conservative.
 */
export function maskLine(line: string, lang: Language): string {
  const quotes = lang === "python" ? ["'", '"'] : ["'", '"', "`"];
  const comment = lang === "python" ? "#" : "//";
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      out += " ";
      if (ch === "\\") {
        out += i + 1 < line.length ? " " : "";
        i++;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (line.startsWith(comment, i)) return out + " ".repeat(line.length - i);
    if (lang !== "python" && line.startsWith("/*", i)) return out + " ".repeat(line.length - i);
    if (quotes.includes(ch)) {
      quote = ch;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

interface Operator {
  pattern: RegExp;
  replace: (match: string) => string;
}

// Spacing is required around < > + - so generics, arrows, JSX, unary minus and ++ are left alone.
const JS_OPERATORS: Operator[] = [
  { pattern: /===|!==|==|!=/g, replace: (m) => ({ "===": "!==", "!==": "===", "==": "!=", "!=": "==" })[m]! },
  { pattern: / (<=|>=|<|>) /g, replace: (m) => ` ${{ "<=": ">", ">=": "<", "<": ">=", ">": "<=" }[m.trim()]} ` },
  { pattern: /&&|\|\|/g, replace: (m) => (m === "&&" ? "||" : "&&") },
  { pattern: /\btrue\b|\bfalse\b/g, replace: (m) => (m === "true" ? "false" : "true") },
  { pattern: / ([+-]) (?!=)/g, replace: (m) => (m.trim() === "+" ? " - " : " + ") },
];

const PY_OPERATORS: Operator[] = [
  { pattern: /==|!=/g, replace: (m) => (m === "==" ? "!=" : "==") },
  { pattern: / (<=|>=|<|>) /g, replace: (m) => ` ${{ "<=": ">", ">=": "<", "<": ">=", ">": "<=" }[m.trim()]} ` },
  { pattern: / and | or /g, replace: (m) => (m === " and " ? " or " : " and ") },
  { pattern: /\bTrue\b|\bFalse\b/g, replace: (m) => (m === "True" ? "False" : "True") },
  { pattern: /(?<=^|[\s(])not (?=\S)/g, replace: () => "" },
  { pattern: / ([+-]) (?!=)/g, replace: (m) => (m.trim() === "+" ? " - " : " + ") },
];

/** A `/` that starts an expression is probably a regex literal; skip such lines rather than mutate inside one. */
const REGEX_LITERAL = /(^|[=(,:!&|?{};]|return)\s*\/[^/*\s]/;

/** Generate up to `perLine` mutants for one line of code. */
export function mutateLine(line: string, lang: Language, perLine = 3): { mutated: string; description: string }[] {
  if (isTrivialLine(line, lang)) return [];
  const masked = maskLine(line, lang);
  if (lang !== "python" && REGEX_LITERAL.test(masked)) return [];
  if (/^\s*(import|from|export\s+\*|@)/.test(masked)) return [];

  const out: { mutated: string; description: string; kind: Operator }[] = [];
  const seen = new Set<string>();
  // At most one change per operator kind, so a line with `==`, `and` and `>` gets all three kinds tried.
  for (const op of lang === "python" ? PY_OPERATORS : JS_OPERATORS) {
    for (const m of masked.matchAll(op.pattern)) {
      if (out.length >= perLine) return out.map(({ mutated, description }) => ({ mutated, description }));
      if (out.some((o) => o.kind === op)) break;
      const at = m.index!;
      const text = m[0];
      const replacement = op.replace(text);
      const mutated = line.slice(0, at) + replacement + line.slice(at + text.length);
      if (mutated === line || seen.has(mutated)) continue;
      seen.add(mutated);
      const from = text.trim() || text;
      const to = replacement.trim() || "(removed)";
      out.push({ mutated, description: `\`${from}\` → \`${to}\``, kind: op });
    }
  }
  return out.map(({ mutated, description }) => ({ mutated, description }));
}

/** Mutants for the added, non-trivial lines of changed source files, spread evenly across files and lines. */
export function generateMutants(
  files: { path: string; content: string; patch: ParsedPatch }[],
  maxMutants: number,
): Mutant[] {
  const perFile: Mutant[][] = files.map((f) => {
    const lang = languageOf(f.path);
    if (!lang) return [];
    const lines = f.content.split("\n");
    return [...f.patch.added]
      .sort((a, b) => a - b)
      .flatMap((n) =>
        mutateLine(lines[n - 1] ?? "", lang).map((m) => ({ path: f.path, line: n, original: lines[n - 1]!, ...m })),
      );
  });
  // Round-robin so one big file doesn't use up the whole budget.
  const picked: Mutant[] = [];
  for (let i = 0; picked.length < maxMutants && perFile.some((list) => i < list.length); i++) {
    for (const list of perFile) if (i < list.length && picked.length < maxMutants) picked.push(list[i]!);
  }
  return picked;
}

export interface MutationOptions {
  root: string;
  repo: RepoReader;
  runners: Map<RunnerLanguage, TestRunner>;
  ignorePaths: string[];
  maxMutants: number;
  /** Overall time budget in milliseconds. */
  budgetMs: number;
  /** Per-run cap in milliseconds. */
  testTimeoutMs: number;
}

/**
 * For each changed source file, run its tests with small deliberate breaks to the changed lines.
 * Every file is restored after each mutant, even if a run throws.
 */
export async function runMutations(changed: ChangedFile[], options: MutationOptions): Promise<MutationReport> {
  const started = Date.now();
  const skipped: MutationReport["skipped"] = [];
  const results: MutantResult[] = [];

  const sources = changed.filter(
    (f) => f.status !== "removed" && f.patch && classifyFile(f.path, options.ignorePaths) === "source",
  );
  const eligible: { path: string; content: string; patch: ParsedPatch; tests: string[]; runner: TestRunner }[] = [];
  for (const f of sources) {
    const runnerLang = runnerLanguageOf(f.path);
    const runner = runnerLang ? options.runners.get(runnerLang) : undefined;
    if (!runner) {
      skipped.push({ path: f.path, reason: "no supported test runner installed for this language" });
      continue;
    }
    const tests = candidateTests(f.path, options.repo).filter((t) => runnerLanguageOf(t) === runner.language);
    if (tests.length === 0) {
      skipped.push({ path: f.path, reason: "no tests found for this file" });
      continue;
    }
    const content = options.repo.read(f.path);
    if (content === null) continue;
    eligible.push({ path: f.path, content, patch: parsePatch(f.patch!), tests, runner });
  }

  const mutants = generateMutants(eligible, options.maxMutants);
  const byPath = new Map(eligible.map((e) => [e.path, e]));
  const baseline = new Map<string, number>();
  let truncated = false;

  for (const mutant of mutants) {
    if (Date.now() - started > options.budgetMs) {
      truncated = true;
      break;
    }
    const file = byPath.get(mutant.path)!;

    // The tests must pass on the unmodified code first, or a failure would mean nothing.
    if (!baseline.has(file.path)) {
      const base = await file.runner.run(file.tests, options.testTimeoutMs);
      if (base.status !== "pass") {
        skipped.push({ path: file.path, reason: `its tests don't pass as-is (${base.status})` });
        baseline.set(file.path, -1);
      } else {
        baseline.set(file.path, base.durationMs);
      }
    }
    const baseMs = baseline.get(file.path)!;
    if (baseMs < 0) continue;

    const abs = join(options.root, file.path);
    const original = readFileSync(abs, "utf8");
    const lines = original.split("\n");
    lines[mutant.line - 1] = mutant.mutated;
    let status: MutantResult["status"];
    try {
      writeFileSync(abs, lines.join("\n"));
      const timeout = Math.min(options.testTimeoutMs, Math.max(30_000, baseMs * 3 + 10_000));
      const run = await file.runner.run(file.tests, timeout);
      status =
        run.status === "pass"
          ? "survived"
          : run.status === "fail"
            ? "killed"
            : run.status === "timeout"
              ? "timeout"
              : "invalid";
    } finally {
      writeFileSync(abs, original);
    }
    results.push({ ...mutant, status, tests: file.tests });
  }

  return { results, skipped, truncated };
}

export function mutationScore(results: MutantResult[]): { killed: number; survived: number; score: number | null } {
  // A timeout usually means the change caused an infinite loop, which the tests did catch.
  const killed = results.filter((r) => r.status === "killed" || r.status === "timeout").length;
  const survived = results.filter((r) => r.status === "survived").length;
  return { killed, survived, score: killed + survived === 0 ? null : killed / (killed + survived) };
}
