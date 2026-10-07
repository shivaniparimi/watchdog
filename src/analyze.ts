import { classifyFile, languageOf } from "./classify.js";
import { parsePatch } from "./diff.js";
import { changedSymbols } from "./symbols.js";
import { candidateTests, mentionExcerpt, type RepoReader } from "./testMap.js";
import type { AnalyzedSymbol, ChangedFile, Config, ParsedPatch, TestEvidence } from "./types.js";

export interface AnalysisResult {
  symbols: AnalyzedSymbol[];
  /** Patches for source files, kept so the reporter knows which lines accept comments. */
  patches: Map<string, ParsedPatch>;
  /** Functions dropped because the PR exceeded maxFunctions. */
  skipped: number;
  sourceFilesChanged: number;
}

/**
 * Rule checks: find changed functions and decide, without AI, whether each one is
 * covered by a test changed in this PR, has existing tests that need a closer look, or has none.
 */
export function analyze(files: ChangedFile[], repo: RepoReader, config: Config): AnalysisResult {
  const changedTests = new Set(
    files
      .filter((f) => f.status !== "removed" && classifyFile(f.path, config.ignorePaths) === "test")
      .map((f) => f.path),
  );
  const sources = files.filter(
    (f) => f.status !== "removed" && f.patch && classifyFile(f.path, config.ignorePaths) === "source",
  );

  const patches = new Map<string, ParsedPatch>();
  const all: AnalyzedSymbol[] = [];

  for (const file of sources) {
    const content = repo.read(file.path);
    const lang = languageOf(file.path);
    if (content === null || !lang) continue;

    const patch = parsePatch(file.patch!);
    patches.set(file.path, patch);
    const candidates = candidateTests(file.path, repo);

    for (const sym of changedSymbols(file.path, lang, content, patch)) {
      const evidence: TestEvidence[] = [];
      for (const testPath of candidates) {
        const testContent = repo.read(testPath);
        const excerpt = testContent ? mentionExcerpt(testContent, sym.name) : null;
        if (excerpt)
          evidence.push({
            path: testPath,
            changedInPr: changedTests.has(testPath),
            excerpt,
          });
      }

      const status =
        evidence.length === 0 ? "untested" : evidence.some((e) => e.changedInPr) ? "covered-in-pr" : "needs-judgment";
      all.push({ ...sym, status, candidateTests: candidates, evidence });
    }
  }

  // Keep the most worrying functions when a PR is too large: untested first, then needs-judgment.
  const order = {
    untested: 0,
    "needs-judgment": 1,
    "covered-in-pr": 2,
  } as const;
  const sorted = [...all].sort(
    (a, b) => order[a.status] - order[b.status] || b.changedLines.length - a.changedLines.length,
  );
  const symbols = sorted.slice(0, config.maxFunctions);

  return {
    symbols,
    patches,
    skipped: all.length - symbols.length,
    sourceFilesChanged: sources.length,
  };
}
