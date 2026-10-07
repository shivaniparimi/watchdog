import { minimatch } from "minimatch";
import { parsePatch } from "../diff.js";
import type { ChangedFile, ParsedPatch } from "../types.js";

export interface ReviewFile {
  path: string;
  status: ChangedFile["status"];
  patch: ParsedPatch;
  /** Diff with each line labelled by its new-file line number, for Claude to cite. */
  annotatedDiff: string;
  /** Full new-file content for context, or null when the file is too long or unreadable. */
  content: string | null;
  additions: number;
  deletions: number;
}

export interface CollectResult {
  /** Files whose diff (and, budget allowing, full content) goes straight into the prompt. */
  files: ReviewFile[];
  /** Changed files over the size budget: Claude reads them with the get_diff and read_file tools. */
  deferred: ReviewFile[];
  /** Changed files that are only listed by name (lockfiles, binaries, generated code). */
  listed: { path: string; reason: string }[];
}

/** Changed files only listed by name: lockfiles, build output, generated or vendored code, binaries. */
const LIST_ONLY: [RegExp, string][] = [
  [
    /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|uv\.lock)$/,
    "lockfile",
  ],
  [/(^|\/)(node_modules|vendor|dist|build|out|coverage|\.next|__generated__|generated)\//, "generated or vendored"],
  [/\.min\.(js|css)$/, "minified"],
  [/\.(snap|map)$/, "generated"],
];

const MAX_CONTEXT_LINES = 3000;

export function annotateDiff(patch: ParsedPatch): string {
  return patch.entries
    .map((e) => (e.kind === "-" ? `       - ${e.text}` : `L${String(e.newLine).padEnd(5)}${e.kind} ${e.text}`))
    .join("\n");
}

/**
 * Gather the whole PR for review. Every changed file is covered: inline in the prompt while the
 * character budget lasts (diff first, full content when it fits), then through tools.
 */
export function collectReviewFiles(
  changed: ChangedFile[],
  readFile: (path: string) => string | null,
  options: { ignorePaths: string[]; maxChars: number },
): CollectResult {
  const files: ReviewFile[] = [];
  const deferred: ReviewFile[] = [];
  const listed: CollectResult["listed"] = [];
  let budget = options.maxChars;

  for (const f of changed) {
    if (options.ignorePaths.some((glob) => minimatch(f.path, glob, { dot: true }))) continue;
    if (f.status === "removed") {
      listed.push({ path: f.path, reason: "deleted" });
      continue;
    }
    const listOnly = LIST_ONLY.find(([re]) => re.test(f.path));
    if (listOnly) {
      listed.push({ path: f.path, reason: listOnly[1] });
      continue;
    }
    if (!f.patch) {
      listed.push({ path: f.path, reason: "binary or too large for a diff" });
      continue;
    }

    const patch = parsePatch(f.patch);
    const annotatedDiff = annotateDiff(patch);
    let content = readFile(f.path);
    if (content !== null && content.split("\n").length > MAX_CONTEXT_LINES) content = null;
    const file: ReviewFile = {
      path: f.path,
      status: f.status,
      patch,
      annotatedDiff,
      content,
      additions: patch.entries.filter((e) => e.kind === "+").length,
      deletions: patch.entries.filter((e) => e.kind === "-").length,
    };

    if (annotatedDiff.length + (content?.length ?? 0) <= budget) {
      budget -= annotatedDiff.length + (content?.length ?? 0);
      files.push(file);
    } else if (annotatedDiff.length <= budget) {
      budget -= annotatedDiff.length;
      files.push({ ...file, content: null }); // Full file still available through read_file.
    } else {
      deferred.push(file);
    }
  }

  return { files, deferred, listed };
}
