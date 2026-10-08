/**
 * Watchdog as a self-hosted server: GitHub sends pull request webhooks here, and Watchdog reviews
 * the PR without GitHub Actions. Configuration comes from environment variables (see the README).
 *
 *   WEBHOOK_SECRET=... GITHUB_TOKEN=... GEMINI_API_KEY=... npm run server
 */
import { createProvider } from "../ai/index.js";
import { createApp } from "./app.js";
import { JobQueue, type TaskName } from "./jobs.js";
import { createWorker } from "./worker.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name}.`);
    process.exit(1);
  }
  return value;
}

const tasks = (process.env.WATCHDOG_TASKS ?? "review,test-gap")
  .split(",")
  .map((t) => t.trim())
  .filter((t): t is TaskName => t === "review" || t === "test-gap");

const ai = createProvider({
  provider: (process.env.AI_PROVIDER as "auto" | "gemini" | "anthropic" | undefined) ?? "auto",
  geminiApiKey: process.env.GEMINI_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.MODEL,
});
if (!ai)
  console.warn("No GEMINI_API_KEY or ANTHROPIC_API_KEY set: AI review is skipped, test gaps use rule checks only.");

const queue = new JobQueue(
  createWorker({
    githubToken: required("GITHUB_TOKEN"),
    ai,
    runTests: process.env.RUN_TESTS === "true",
  }),
);
const app = createApp({
  webhookSecret: required("WEBHOOK_SECRET"),
  apiKey: process.env.WATCHDOG_API_KEY,
  tasks: tasks.length ? tasks : ["review", "test-gap"],
  queue,
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`Watchdog server listening on :${port} (tasks: ${tasks.join(", ")}, AI: ${ai?.model ?? "off"})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log("Shutting down after the current job...");
    server.close();
    void queue.idle().then(() => process.exit(0));
  });
}
