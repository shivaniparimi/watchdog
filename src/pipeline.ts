import { analyze, type AnalysisResult } from "./analyze.js";
import type { RepoReader } from "./testMap.js";
import type { AnalyzedSymbol, ChangedFile, Config, Finding, Risk, Verdict } from "./types.js";

export type Judge = (symbols: AnalyzedSymbol[]) => Promise<Map<string, Verdict>>;

export interface PipelineResult extends Omit<AnalysisResult, "symbols"> {
  findings: Finding[];
  /** Why AI review didn't run, if it didn't. */
  aiNote?: string;
}

/** What the rule check concludes on its own, used when AI is off or fails. */
export function ruleVerdict(sym: AnalyzedSymbol): Verdict {
  switch (sym.status) {
    case "covered-in-pr":
      return {
        covered: true,
        risk: "none",
        reason: `A test changed in this PR mentions \`${sym.name}\` (${sym.evidence.find((e) => e.changedInPr)!.path}).`,
        suggestedTest: "",
        source: "rule",
      };
    case "untested":
      return {
        covered: false,
        risk: "medium",
        reason: sym.isNew
          ? `New function \`${sym.name}\` has no test that mentions it.`
          : `\`${sym.name}\` changed and no test file mentions it.`,
        suggestedTest: "",
        source: "rule",
      };
    case "needs-judgment":
      return {
        covered: false,
        risk: "low",
        reason: `Existing tests mention \`${sym.name}\` but weren't updated; couldn't confirm they cover the change.`,
        suggestedTest: "",
        source: "rule",
        uncertain: true,
      };
  }
}

export const RISK_RANK: Record<Risk, number> = { high: 3, medium: 2, low: 1, none: 0 };

export function isGap(f: Finding): boolean {
  return !f.verdict.covered && f.verdict.risk !== "none";
}

export async function findTestGaps(
  files: ChangedFile[],
  repo: RepoReader,
  config: Config,
  judge?: Judge,
): Promise<PipelineResult> {
  const { symbols, ...rest } = analyze(files, repo, config);
  const toJudge = symbols.filter((s) => s.status !== "covered-in-pr");

  let aiVerdicts = new Map<string, Verdict>();
  let aiNote: string | undefined;
  if (!judge) {
    aiNote = "AI review is off, so functions with existing but unchanged tests weren't checked.";
  } else if (toJudge.length > 0) {
    try {
      aiVerdicts = await judge(toJudge);
    } catch (err) {
      aiNote = `AI review failed (${err instanceof Error ? err.message : String(err)}); showing rule-check results only.`;
    }
  }

  const findings = symbols
    .map((s) => ({ ...s, verdict: aiVerdicts.get(s.id) ?? ruleVerdict(s) }))
    .sort((a, b) => RISK_RANK[b.verdict.risk] - RISK_RANK[a.verdict.risk] || a.path.localeCompare(b.path) || a.start - b.start);

  return { ...rest, findings, aiNote };
}
