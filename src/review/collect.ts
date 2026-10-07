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
  files: ReviewFile[];
  skipped: { path: string; reason: string }[];
}

/** Files not worth an AI review: lockfiles, build output, generated or vendored code, binaries, docs. */
const NOT_REVIEWED = [
  /(^|\/)(node_modules|vendor|dist|build|out|coverage|\.next|__generated__|generated)\//,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/,
  /\.min\.(js|css)$/,
  /\.(snap|svg|png|jpe?g|gif|ico|pdf|zip|woff2?|ttf|map)$/i,
  /\.(md|mdx|txt|rst)$/i,
];

const MAX_CONTEXT_LINES = 800;

export function annotateDiff(patch: ParsedPatch): string {
  return patch.entries
    .map((e) => (e.kind === "-" ? `       - ${e.text}` : `L${String(e.newLine).padEnd(5)}${e.kind} ${e.text}`))
    .join("\n");
}

/**
 * Pick the changed files to review, staying within a character budget so huge PRs don't
 * blow up cost. Files are taken in the order GitHub lists them.
 */
export function collectReviewFiles(
  changed: ChangedFile[],
  readFile: (path: string) => string | null,
  options: { ignorePaths: string[]; maxChars: number },
): CollectResult {
  const files: ReviewFile[] = [];
  const skipped: CollectResult["skipped"] = [];
  let budget = options.maxChars;

  for (const f of changed) {
    if (f.status === "removed") continue;
    if (NOT_REVIEWED.some((re) => re.test(f.path))) continue;
    if (options.ignorePaths.some((glob) => minimatch(f.path, glob, { dot: true }))) continue;
    if (!f.patch) {
      skipped.push({
        path: f.path,
        reason: "no diff available (binary or too large)",
      });
      continue;
    }

    const patch = parsePatch(f.patch);
    const annotatedDiff = annotateDiff(patch);
    let content = readFile(f.path);
    if (content !== null && content.split("\n").length > MAX_CONTEXT_LINES) content = null;

    let size = annotatedDiff.length + (content?.length ?? 0);
    if (size > budget && content !== null) {
      content = null; // Try again with just the diff.
      size = annotatedDiff.length;
    }
    if (size > budget) {
      skipped.push({ path: f.path, reason: "over the review size budget" });
      continue;
    }
    budget -= size;

    files.push({
      path: f.path,
      status: f.status,
      patch,
      annotatedDiff,
      content,
      additions: patch.entries.filter((e) => e.kind === "+").length,
      deletions: patch.entries.filter((e) => e.kind === "-").length,
    });
  }

  return { files, skipped };
}

/** Group files into batches of roughly `maxChars` each, so each Claude call stays focused. */
export function batchFiles(files: ReviewFile[], maxChars: number): ReviewFile[][] {
  const batches: ReviewFile[][] = [];
  let current: ReviewFile[] = [];
  let size = 0;
  for (const f of files) {
    const s = f.annotatedDiff.length + (f.content?.length ?? 0);
    if (current.length > 0 && size + s > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(f);
    size += s;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
