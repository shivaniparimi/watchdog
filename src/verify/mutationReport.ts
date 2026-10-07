import type { PipelineResult } from "../pipeline.js";
import type { InlineComment } from "../report.js";
import { mutationScore, type MutationReport, type MutantResult } from "./mutate.js";

function where(r: MutantResult): string {
  return `\`${r.path}:${r.line}\``;
}

/**
 * Use mutation results to correct test-gap verdicts: a function the rule check or AI called covered,
 * but where a deliberate break on a changed line went unnoticed, is run by tests without being checked.
 */
export function applyMutations(result: PipelineResult, report: MutationReport): void {
  for (const r of report.results) {
    if (r.status !== "survived") continue;
    const finding = result.findings.find((f) => f.path === r.path && f.start <= r.line && r.line <= f.end);
    if (!finding || !finding.verdict.covered) continue;
    finding.verdict = {
      covered: false,
      risk: "medium",
      reason: `Changing ${r.description} on line ${r.line} didn't make any test fail, so the tests run this code without checking it.`,
      suggestedTest: "",
      source: "mutation",
    };
  }
}

export function mutationKey(r: MutantResult): string {
  return `<!-- test-gap-mutant:${r.path}:${r.line}:${r.description.replace(/[`\s]/g, "")} -->`;
}

/** One inline comment per surviving mutant, on lines the PR changed. */
export function mutationComments(report: MutationReport, max = 10): InlineComment[] {
  return report.results
    .filter((r) => r.status === "survived")
    .slice(0, max)
    .map((r) => ({
      path: r.path,
      line: r.line,
      key: mutationKey(r),
      body: `${mutationKey(r)}\n**🧬 No test catches a change here**\n\nWatchdog changed ${r.description} on this line and every test still passed (${r.tests.map((t) => `\`${t}\``).join(", ")}). A test that checks this line's result would catch the bug if it were ever broken this way.\n\n<details><summary>The change that went unnoticed</summary>\n\n\`\`\`diff\n- ${r.original.trim()}\n+ ${r.mutated.trim()}\n\`\`\`\n</details>`,
    }));
}

export function mutationMarkdown(report: MutationReport): string {
  const { killed, survived, score } = mutationScore(report.results);
  const lines = ["", "### 🧬 Mutation check on changed lines", ""];
  if (score === null) {
    lines.push("No changed lines could be checked.");
  } else {
    lines.push(
      `Watchdog made ${killed + survived} small deliberate breaks to changed lines and ran their tests: **${killed} caught, ${survived} unnoticed** (${Math.round(score * 100)}%).`,
    );
    const survivors = report.results.filter((r) => r.status === "survived");
    if (survivors.length > 0) {
      lines.push("", "| Location | Change no test noticed |", "|---|---|");
      for (const r of survivors) lines.push(`| ${where(r)} | ${r.description} |`);
    }
  }
  const invalid = report.results.filter((r) => r.status === "invalid").length;
  const notes: string[] = [];
  if (invalid > 0) notes.push(`${invalid} change(s) broke the code itself and were not counted`);
  if (report.truncated) notes.push("the time budget ran out before every change was tried");
  for (const s of report.skipped) notes.push(`\`${s.path}\`: ${s.reason}`);
  if (notes.length > 0) lines.push("", `<sub>${notes.join("; ")}.</sub>`);
  return lines.join("\n");
}
