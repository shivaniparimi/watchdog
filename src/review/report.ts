import type { InlineComment } from "../report.js";
import type { ReviewFile } from "./collect.js";
import { SEVERITIES, type RawFinding, type ReviewSummary, type Severity } from "./review.js";

export const REVIEW_SUMMARY_MARKER = "<!-- watchdog-review-summary -->";
const KEY_PATTERN = /<!-- watchdog-review path=(\S+) line=(\d+) category=(\S+) -->/;

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "🔴 Critical",
  major: "🟠 Major",
  minor: "🟡 Minor",
  nit: "⚪ Nit",
};
const VERDICT_LABEL = {
  "looks-good": "✅ Looks good",
  "minor-issues": "💬 Minor issues",
  "needs-changes": "⚠️ Needs changes",
} as const;

export interface Finding extends RawFinding {
  /** False when the cited line isn't in the diff; the finding is shown in the summary only. */
  inline: boolean;
}

/**
 * Check each finding against the diff. A line GitHub won't accept becomes a summary-only finding;
 * an invalid multi-line range is narrowed to one line, and its suggestion dropped.
 */
export function validateFindings(raw: RawFinding[], files: ReviewFile[]): Finding[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  return raw.map((f) => {
    const commentable = byPath.get(f.path)?.patch.commentable;
    if (!commentable?.has(f.line)) return { ...f, start_line: null, suggestion: "", inline: false };

    if (f.start_line !== null) {
      let valid = f.start_line < f.line;
      for (let l = f.start_line; valid && l <= f.line; l++) valid = commentable.has(l);
      if (!valid) return { ...f, start_line: null, suggestion: "", inline: true };
    }
    return { ...f, inline: true };
  });
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  );
}

function key(f: Finding): string {
  return `<!-- watchdog-review path=${f.path} line=${f.line} category=${f.category} -->`;
}

/** True when an earlier run already commented on the same problem (same file and category, within 3 lines). */
export function isDuplicate(c: InlineComment, existingBodies: string[]): boolean {
  const mine = KEY_PATTERN.exec(c.key);
  if (!mine) return false;
  return existingBodies.some((body) => {
    const other = KEY_PATTERN.exec(body);
    return (
      other !== null &&
      other[1] === mine[1] &&
      other[3] === mine[3] &&
      Math.abs(Number(other[2]) - Number(mine[2])) <= 3
    );
  });
}

export function reviewComments(findings: Finding[], minSeverity: Severity, maxComments: number): InlineComment[] {
  const threshold = SEVERITIES.indexOf(minSeverity);
  return sortFindings(findings)
    .filter((f) => f.inline && SEVERITIES.indexOf(f.severity) <= threshold)
    .slice(0, maxComments)
    .map((f) => {
      let body = `${key(f)}\n**${SEVERITY_LABEL[f.severity]} · ${f.category}** — ${f.title}\n\n${f.body}`;
      if (f.suggestion.trim()) body += `\n\n\`\`\`suggestion\n${f.suggestion.replace(/\n+$/, "")}\n\`\`\``;
      return {
        path: f.path,
        line: f.line,
        startLine: f.start_line ?? undefined,
        body,
        key: key(f),
      };
    });
}

export function reviewSummaryMarkdown(args: {
  summary: ReviewSummary | null;
  findings: Finding[];
  postedKeys: Set<string>;
  filesReviewed: number;
  /** Changed files only listed by name (lockfiles, binaries, deleted, generated). */
  listed: { path: string; reason: string }[];
  toolCalls: number;
  model: string;
}): string {
  const { summary, findings, postedKeys, filesReviewed, listed, toolCalls, model } = args;
  const lines = [REVIEW_SUMMARY_MARKER, "## 🐕 Watchdog code review", ""];

  if (summary) {
    lines.push(`**Score: ${summary.score}/10** · ${VERDICT_LABEL[summary.verdict]}`, "", summary.overview, "");
  }

  if (findings.length === 0) {
    lines.push("No issues found in the changed code.");
  } else {
    const counts = SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(
      ([, n]) => n > 0,
    );
    lines.push(
      `**${findings.length} finding(s):** ${counts.map(([s, n]) => `${SEVERITY_LABEL[s]} ${n}`).join(" · ")}`,
      "",
    );
    lines.push("| Severity | Location | Issue |", "|---|---|---|");
    for (const f of sortFindings(findings)) {
      const where = postedKeys.has(key(f)) ? "" : f.inline ? " _(not posted inline)_" : " _(line not in diff)_";
      lines.push(
        `| ${SEVERITY_LABEL[f.severity]} | \`${f.path}:${f.line}\` | ${f.title.replace(/\|/g, "\\|")}${where} |`,
      );
    }
    const generalOnes = sortFindings(findings).filter((f) => !f.inline);
    if (generalOnes.length > 0) {
      lines.push("", "<details><summary>Findings that couldn't be attached to a diff line</summary>", "");
      for (const f of generalOnes) lines.push(`**${f.title}** (\`${f.path}:${f.line}\`): ${f.body}`, "");
      lines.push("</details>");
    }
  }

  if (summary?.strengths.length) lines.push("", "**What's good**", ...summary.strengths.map((s) => `- ${s}`));
  if (summary?.risks.length) lines.push("", "**Worth a human look**", ...summary.risks.map((s) => `- ${s}`));

  const notes = [`Reviewed ${filesReviewed} changed file(s) with ${model}`];
  if (toolCalls > 0) notes.push(`read ${toolCalls} piece(s) of surrounding code`);
  let footer = `${notes.join(", ")}.`;
  if (listed.length > 0) {
    footer += ` Also changed, not reviewed line by line: ${listed.map((l) => `\`${l.path}\` (${l.reason})`).join(", ")}.`;
  }
  lines.push("", `<sub>${footer}</sub>`);
  return lines.join("\n");
}
