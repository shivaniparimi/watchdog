/**
 * Run Watchdog's AI tasks on a local git repo, comparing the working tree to a base branch.
 *
 *   npm run local -- [--task review|test-gap] [--repo <path>] [--base <ref>] [--no-ai] [--model <id>] [--json]
 *
 * Nothing is posted anywhere; results are printed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { splitGitDiff } from "./diff.js";
import { DEFAULT_MODEL, judge } from "./judge.js";
import { findTestGaps } from "./pipeline.js";
import { fsRepo } from "./repo.js";
import { inlineComments, summaryMarkdown } from "./report.js";
import { collectReviewFiles } from "./review/collect.js";
import { readLintResults } from "./review/lintResults.js";
import { reviewComments, reviewSummaryMarkdown, validateFindings } from "./review/report.js";
import { reviewPr, summarize } from "./review/review.js";

const { values } = parseArgs({
  options: {
    task: { type: "string", default: "review" },
    repo: { type: "string", default: process.cwd() },
    base: { type: "string" },
    "no-ai": { type: "boolean", default: false },
    model: { type: "string", default: DEFAULT_MODEL },
    json: { type: "boolean", default: false },
    "max-functions": { type: "string", default: "40" },
    "lint-results": { type: "string" },
  },
});

const root = values.repo!;
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();

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
const branch = git("rev-parse", "--abbrev-ref", "HEAD");

async function testGap(): Promise<void> {
  const result = await findTestGaps(
    files,
    fsRepo(root),
    {
      ignorePaths: [],
      failOn: "none",
      maxFunctions: Number(values["max-functions"]),
    },
    values["no-ai"] ? undefined : (symbols) => judge(symbols, { model: values.model, repoRoot: root }),
  );
  if (values.json) return console.log(JSON.stringify(result.findings, null, 2));

  console.log(summaryMarkdown(result));
  const comments = inlineComments(result);
  if (comments.length > 0) {
    console.log("\n## Inline comments that would be posted\n");
    for (const c of comments) console.log(`### ${c.path}:${c.line}\n${c.body.replace(/^<!--.*-->\n/, "")}\n`);
  }
}

async function review(): Promise<void> {
  if (values["no-ai"]) throw new Error("The review task needs AI; drop --no-ai.");
  const read = (path: string) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return null;
    }
  };
  const collected = collectReviewFiles(files, read, { ignorePaths: [], maxChars: 400_000 });
  const reviewable = [...collected.files, ...collected.deferred];
  if (reviewable.length === 0) return console.log("No reviewable changes.");

  const commits = git("log", "--reverse", "--format=%B%x00", `${mergeBase}..HEAD`)
    .split("\0")
    .map((c) => c.trim())
    .filter(Boolean);
  const pr = { title: `Local changes on ${branch}`, body: "", author: "local", commits };
  const options = {
    client: new Anthropic(),
    model: values.model!,
    lintResults: readLintResults(values["lint-results"]),
    repoRoot: root,
  };
  const { findings: raw, toolCalls } = await reviewPr(pr, collected, options);
  const findings = validateFindings(raw, reviewable);
  if (values.json) return console.log(JSON.stringify(findings, null, 2));

  const summary = await summarize(pr, reviewable, findings, options);
  const comments = reviewComments(findings, "nit", 100);
  console.log(
    reviewSummaryMarkdown({
      summary,
      findings,
      postedKeys: new Set(comments.map((c) => c.key)),
      filesReviewed: reviewable.length,
      listed: collected.listed,
      toolCalls,
      model: values.model!,
    }),
  );
  if (comments.length > 0) {
    console.log("\n## Inline comments that would be posted\n");
    for (const c of comments)
      console.log(
        `### ${c.path}:${c.startLine ? `${c.startLine}-` : ""}${c.line}\n${c.body.replace(/^<!--.*-->\n/, "")}\n`,
      );
  }
}

if (values.task === "test-gap") await testGap();
else if (values.task === "review") await review();
else throw new Error(`--task must be review or test-gap (got "${values.task}")`);
