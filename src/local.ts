/**
 * Run the test gap finder on a local git repo, comparing the working tree to a base branch.
 *
 *   npm run local -- [--repo <path>] [--base <ref>] [--no-ai] [--model <id>] [--json]
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { splitGitDiff } from "./diff.js";
import { DEFAULT_MODEL, judge } from "./judge.js";
import { findTestGaps } from "./pipeline.js";
import { fsRepo } from "./repo.js";
import { inlineComments, summaryMarkdown } from "./report.js";

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: process.cwd() },
    base: { type: "string" },
    "no-ai": { type: "boolean", default: false },
    model: { type: "string", default: DEFAULT_MODEL },
    json: { type: "boolean", default: false },
    "max-functions": { type: "string", default: "40" },
  },
});

const root = values.repo!;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

function defaultBase(): string {
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    try {
      git("rev-parse", "--verify", "--quiet", ref);
      return ref;
    } catch {
      // try the next one
    }
  }
  throw new Error("Couldn't find a base branch; pass --base <ref>.");
}

const base = values.base ?? defaultBase();
const mergeBase = git("merge-base", base, "HEAD");
// Diff the working tree against the merge base, so uncommitted changes count too.
const files = splitGitDiff(git("diff", "--no-color", "--no-ext-diff", "--unified=3", mergeBase));

const useAi = !values["no-ai"];
const result = await findTestGaps(
  files,
  fsRepo(root),
  { ignorePaths: [], failOn: "none", maxFunctions: Number(values["max-functions"]) },
  useAi ? (symbols) => judge(symbols, { model: values.model }) : undefined,
);

if (values.json) {
  console.log(JSON.stringify(result.findings, null, 2));
} else {
  console.log(summaryMarkdown(result));
  const comments = inlineComments(result);
  if (comments.length > 0) {
    console.log("\n## Inline comments that would be posted\n");
    for (const c of comments) console.log(`### ${c.path}:${c.line}\n${c.body.replace(/^<!--.*-->\n/, "")}\n`);
  }
}
