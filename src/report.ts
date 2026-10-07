import { isGap, RISK_RANK, type PipelineResult } from "./pipeline.js";
import type { Config, Finding, ParsedPatch } from "./types.js";

export const SUMMARY_MARKER = "<!-- test-gap-summary -->";

export interface InlineComment {
  path: string;
  line: number;
  /** First line of a multi-line comment (needed for multi-line suggestions). */
  startLine?: number;
  body: string;
  /** Stable key used to avoid posting the same comment twice when the PR is updated. */
  key: string;
}

export function commentKey(f: Pick<Finding, "path" | "name">): string {
  return `<!-- test-gap:${f.path}#${f.name} -->`;
}

const RISK_LABEL = {
  high: "🔴 High",
  medium: "🟠 Medium",
  low: "🟡 Low",
  none: "—",
} as const;

/** Pick a line GitHub will accept a comment on: the function's first line, else its first changed line. */
function anchorLine(f: Finding, patch: ParsedPatch | undefined): number | null {
  if (!patch) return null;
  if (patch.commentable.has(f.start)) return f.start;
  return f.changedLines.find((l) => patch.commentable.has(l)) ?? null;
}

export function inlineComments(result: PipelineResult): InlineComment[] {
  const comments: InlineComment[] = [];
  for (const f of result.findings) {
    // Gaps found by the mutation check get their own, more specific comments.
    if (!isGap(f) || f.verdict.uncertain || f.verdict.source === "mutation") continue;
    const line = anchorLine(f, result.patches.get(f.path));
    if (line === null) continue;

    let body = `${commentKey(f)}\n**Test gap · ${RISK_LABEL[f.verdict.risk]} risk** — \`${f.name}\`\n\n${f.verdict.reason}`;
    if (f.verdict.suggestedTest.trim()) {
      body += `\n\n<details><summary>Suggested test</summary>\n\n\`\`\`${f.language}\n${f.verdict.suggestedTest.trim()}\n\`\`\`\n</details>`;
    }
    comments.push({ path: f.path, line, body, key: commentKey(f) });
  }
  return comments;
}

function statusLabel(f: Finding): string {
  if (f.verdict.covered) return "✅ Covered";
  if (f.verdict.risk === "none") return "➖ No test needed";
  if (f.verdict.uncertain) return "❔ Unverified";
  return "⚠️ Untested";
}

export function summaryMarkdown(result: PipelineResult): string {
  const gaps = result.findings.filter((f) => isGap(f) && !f.verdict.uncertain);
  const lines = [SUMMARY_MARKER, "## 🧪 Test gap report", ""];

  if (result.findings.length === 0) {
    lines.push(
      result.sourceFilesChanged === 0
        ? "No source files with logic changes in this PR."
        : "No function-level logic changes found in this PR.",
    );
  } else {
    lines.push(
      gaps.length === 0
        ? `Checked ${result.findings.length} changed function(s). No test gaps found. 🎉`
        : `Checked ${result.findings.length} changed function(s). **${gaps.length}** look untested.`,
      "",
      "| Function | Location | Status | Risk | Why |",
      "|---|---|---|---|---|",
    );
    for (const f of result.findings) {
      const why = f.verdict.reason.replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(
        `| \`${f.name}\` | \`${f.path}:${f.start}\` | ${statusLabel(f)} | ${isGap(f) ? RISK_LABEL[f.verdict.risk] : "—"} | ${why} |`,
      );
    }
  }

  if (result.skipped > 0) lines.push("", `_${result.skipped} more changed function(s) skipped (max-functions limit)._`);
  if (result.aiNote) lines.push("", `_${result.aiNote}_`);
  return lines.join("\n");
}

/** Should the check fail? `failOn: "medium"` fails on medium or high gaps. */
export function shouldFail(result: PipelineResult, failOn: Config["failOn"]): boolean {
  if (failOn === "none") return false;
  const threshold = RISK_RANK[failOn];
  return result.findings.some((f) => isGap(f) && !f.verdict.uncertain && RISK_RANK[f.verdict.risk] >= threshold);
}
