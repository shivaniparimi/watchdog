export type Language = "ts" | "js" | "python" | "go" | "java";

export type FileKind = "source" | "test" | "ignore";

/** One changed file in the PR, as GitHub (or local git) reports it. */
export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  /** Unified diff for this file. Missing for binary or very large files. */
  patch?: string;
}

/** A line in a parsed patch. `newLine` is the line number in the new file. */
export interface PatchEntry {
  kind: "+" | "-" | " ";
  /** For "+" and " ": this line's number. For "-": the new-file line the removal sits before. */
  newLine: number;
  text: string;
}

export interface ParsedPatch {
  entries: PatchEntry[];
  /** New-file line numbers that were added. */
  added: Set<number>;
  /** New-file line numbers GitHub accepts review comments on (added + context). */
  commentable: Set<number>;
}

export interface FunctionDef {
  name: string;
  /** 1-based, inclusive. */
  start: number;
  end: number;
}

/** A function whose logic changed in the PR. */
export interface ChangedSymbol {
  id: string;
  path: string;
  language: Language;
  name: string;
  start: number;
  end: number;
  /** True when every line of the function is new. */
  isNew: boolean;
  /** Non-trivial changed lines (new-file numbers). */
  changedLines: number[];
  /** Diff lines inside the function, labelled with line numbers. */
  diffSnippet: string;
  /** Full function body from the new file. */
  body: string;
}

export type GapStatus = "covered-in-pr" | "needs-judgment" | "untested";

export interface TestEvidence {
  path: string;
  changedInPr: boolean;
  /** Lines around each mention of the function name. */
  excerpt: string;
}

export interface AnalyzedSymbol extends ChangedSymbol {
  status: GapStatus;
  candidateTests: string[];
  evidence: TestEvidence[];
}

export type Risk = "high" | "medium" | "low" | "none";

export interface Verdict {
  covered: boolean;
  risk: Risk;
  reason: string;
  suggestedTest: string;
  /** Who decided: the AI, the rule check on its own, or a mutation that no test caught. */
  source: "ai" | "rule" | "mutation";
  /** The rule check couldn't decide and AI was unavailable; shown in the summary only. */
  uncertain?: boolean;
}

export interface Finding extends AnalyzedSymbol {
  verdict: Verdict;
}

export interface Config {
  ignorePaths: string[];
  maxFunctions: number;
  failOn: "none" | "high" | "medium" | "low";
}
