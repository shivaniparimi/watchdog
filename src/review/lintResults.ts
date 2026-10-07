import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_LOG_CHARS = 3000;
const MAX_TOTAL_CHARS = 15000;

/**
 * Turn the lint job's results directory (summary.tsv plus one log per tool) into text for the
 * review prompt: one status line per tool, and the start of the log for each failure or warning.
 */
export function readLintResults(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  const summaryPath = join(dir, "summary.tsv");
  if (!existsSync(summaryPath)) return undefined;

  const rows = readFileSync(summaryPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const out = rows.map(([lang, tool, status, note]) => `${lang}/${tool}: ${status}${note ? ` (${note})` : ""}`);

  let total = out.join("\n").length;
  for (const [, tool, status] of rows) {
    if (status !== "fail" && status !== "warn") continue;
    const logPath = join(dir, `${tool}.log`);
    if (!existsSync(logPath)) continue;
    let log = readFileSync(logPath, "utf8").trim();
    if (log.length > MAX_LOG_CHARS) log = `${log.slice(0, MAX_LOG_CHARS)}\n…(truncated)`;
    if (total + log.length > MAX_TOTAL_CHARS) break;
    out.push("", `--- ${tool} output ---`, log);
    total += log.length;
  }
  return out.join("\n");
}
