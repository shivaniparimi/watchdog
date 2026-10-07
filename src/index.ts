import * as core from "@actions/core";
import { loadContext } from "./tasks/context.js";
import { runReview } from "./tasks/review.js";
import { runTestGap } from "./tasks/testGap.js";

async function run(): Promise<void> {
  const task = core.getInput("task") || "review";
  if (task !== "review" && task !== "test-gap") throw new Error(`task must be "review" or "test-gap" (got "${task}")`);

  const ctx = await loadContext();
  if (!ctx) {
    core.info("Not a pull_request event; nothing to do.");
    return;
  }
  if (task === "review") await runReview(ctx);
  else await runTestGap(ctx);
}

run().catch((err) => core.setFailed(err instanceof Error ? err.message : String(err)));
