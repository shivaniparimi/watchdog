import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

const MAX_READ_LINES = 400;
const MAX_OUTPUT_CHARS = 40_000;
const MAX_SEARCH_MATCHES = 100;
const MAX_LIST_FILES = 300;
/** Paths the tools never expose: git internals and Watchdog's own checkout inside the workspace. */
const HIDDEN = /^(\.git|\.watchdog)(\/|$)/;

function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(output truncated)` : text;
}

/**
 * Resolve a model-supplied path inside `root`, or return null if it escapes it.
 * Tool inputs are untrusted, so `..`, absolute paths and symlinks pointing outside are rejected.
 */
export function safePath(root: string, path: string): string | null {
  if (isAbsolute(path) || path.includes("\0")) return null;
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, path);
  const rel = relative(realRoot, target);
  if (rel.startsWith("..") || isAbsolute(rel) || HIDDEN.test(rel)) return null;
  if (!existsSync(target)) return target; // Caller reports "not found".
  const real = realpathSync(target);
  const realRel = relative(realRoot, real);
  if (realRel.startsWith("..") || isAbsolute(realRel) || HIDDEN.test(realRel)) return null;
  return real;
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 20_000 });
  } catch (err) {
    // git grep exits 1 when nothing matches.
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1) return e.stdout ?? "";
    throw err;
  }
}

/** Read-only tools for exploring the repository at the PR's head commit. */
export function repoTools(root: string, diffs: Map<string, string> = new Map()) {
  const readFile = betaZodTool({
    name: "read_file",
    description:
      "Read a file from the repository at the PR's head commit, with line numbers. Use it to see code the PR " +
      `doesn't change: callers, definitions, types, tests, configs. Returns at most ${MAX_READ_LINES} lines per call.`,
    inputSchema: z.object({
      path: z.string().describe("Path relative to the repository root"),
      start_line: z.number().int().optional().describe("First line to return (1-based)"),
      end_line: z.number().int().optional().describe("Last line to return (inclusive)"),
    }),
    run: async ({ path, start_line, end_line }) => {
      const target = safePath(root, path);
      if (!target) return `Error: ${path} is outside the repository.`;
      if (!existsSync(target)) return `Error: ${path} does not exist.`;
      if (statSync(target).isDirectory()) return `Error: ${path} is a directory; use list_files.`;
      const lines = readFileSync(target, "utf8").split("\n");
      const start = Math.max(1, start_line ?? 1);
      const end = Math.min(lines.length, end_line ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
      const body = lines
        .slice(start - 1, end)
        .map((l, i) => `${start + i}: ${l}`)
        .join("\n");
      const more =
        end < lines.length ? `\n…(${lines.length - end} more lines; call again with start_line=${end + 1})` : "";
      return clip(`${path} (lines ${start}-${end} of ${lines.length})\n${body}${more}`);
    },
  });

  const searchCode = betaZodTool({
    name: "search_code",
    description:
      "Search tracked files for a pattern (git grep), e.g. to find every caller of a changed function or where " +
      `a type is defined. Returns up to ${MAX_SEARCH_MATCHES} matching lines as path:line: text.`,
    inputSchema: z.object({
      pattern: z.string().describe("Text or extended regular expression to search for"),
      regex: z
        .boolean()
        .optional()
        .describe("Treat pattern as a POSIX extended regular expression (use [0-9] and [[:space:]], not \\d or \\s)"),
      path_glob: z.string().optional().describe("Limit to paths matching this glob, e.g. 'src/**/*.ts'"),
    }),
    run: async ({ pattern, regex, path_glob }) => {
      const args = ["grep", "-n", "-I", "--no-color", regex ? "-E" : "-F", "-e", pattern, "--"];
      args.push(path_glob ? `:(glob)${path_glob}` : ".", ":(exclude).watchdog");
      const lines = git(root, args).split("\n").filter(Boolean);
      if (lines.length === 0) return "No matches.";
      const shown = lines.slice(0, MAX_SEARCH_MATCHES).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
      const more =
        lines.length > MAX_SEARCH_MATCHES
          ? `\n…(${lines.length - MAX_SEARCH_MATCHES} more matches; narrow the search)`
          : "";
      return clip(shown.join("\n") + more);
    },
  });

  const listFiles = betaZodTool({
    name: "list_files",
    description: `List tracked files, optionally under a directory or matching a glob. Returns up to ${MAX_LIST_FILES} paths.`,
    inputSchema: z.object({
      directory: z.string().optional().describe("Directory relative to the repository root"),
      glob: z.string().optional().describe("Glob such as '**/*.test.ts'"),
    }),
    run: async ({ directory, glob }) => {
      if (directory && !safePath(root, directory)) return `Error: ${directory} is outside the repository.`;
      const spec = glob ? `:(glob)${directory ? `${directory.replace(/\/$/, "")}/` : ""}${glob}` : directory || ".";
      const files = git(root, ["ls-files", "--", spec])
        .split("\n")
        .filter((f) => f && !HIDDEN.test(f));
      if (files.length === 0) return "No files.";
      const more = files.length > MAX_LIST_FILES ? `\n…(${files.length - MAX_LIST_FILES} more)` : "";
      return files.slice(0, MAX_LIST_FILES).join("\n") + more;
    },
  });

  const getDiff = betaZodTool({
    name: "get_diff",
    description: "Get the PR's diff for one changed file, with new-file line numbers (L<n>).",
    inputSchema: z.object({ path: z.string().describe("Changed file path") }),
    run: async ({ path }) => diffs.get(path) ?? `No diff for ${path}: it isn't one of this PR's changed files.`,
  });

  return [readFile, searchCode, listFiles, getDiff] as const;
}
