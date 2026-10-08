import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { JobQueue, TaskName } from "./jobs.js";

export interface AppOptions {
  /** Secret configured on the GitHub webhook; every delivery's signature is checked against it. */
  webhookSecret: string;
  /** Bearer token for the /api routes. When unset, those routes are disabled. */
  apiKey?: string;
  /** Tasks to run for webhook-triggered jobs. */
  tasks: TaskName[];
  queue: JobQueue;
}

const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

const ReviewRequest = z.object({
  owner: z.string().regex(/^[\w.-]+$/),
  repo: z.string().regex(/^[\w.-]+$/),
  pullNumber: z.number().int().positive(),
  tasks: z
    .array(z.enum(["review", "test-gap"]))
    .min(1)
    .optional(),
});

/** Check GitHub's `X-Hub-Signature-256` header (HMAC-SHA256 of the raw body) in constant time. */
export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp(options: AppOptions): express.Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", jobs: options.queue.counts() });
  });

  // GitHub webhooks: the raw body is needed to verify the signature, so it's parsed here, not globally.
  app.post("/webhooks/github", express.raw({ type: "application/json", limit: "10mb" }), (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !verifySignature(options.webhookSecret, body, req.header("x-hub-signature-256"))) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    const event = req.header("x-github-event");
    let payload: {
      action?: string;
      pull_request?: { number: number; draft?: boolean };
      repository?: { name: string; owner: { login: string } };
    };
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      res.status(400).json({ error: "invalid JSON" });
      return;
    }

    if (event === "ping") {
      res.json({ pong: true });
      return;
    }
    const pull = payload.pull_request;
    if (
      event !== "pull_request" ||
      !pull ||
      !payload.repository ||
      !PR_ACTIONS.has(payload.action ?? "") ||
      pull.draft
    ) {
      res.status(204).end();
      return;
    }
    const job = options.queue.enqueue({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pullNumber: pull.number,
      tasks: options.tasks,
      trigger: "webhook",
    });
    res.status(202).json({ jobId: job.id });
  });

  // REST API for starting a review on demand and checking on jobs.
  const api = express.Router();
  api.use(express.json({ limit: "100kb" }));
  api.use((req: Request, res: Response, next: NextFunction) => {
    if (!options.apiKey) {
      res.status(404).json({ error: "the API is disabled; set WATCHDOG_API_KEY to enable it" });
      return;
    }
    const token = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!safeEqual(token, options.apiKey)) {
      res.status(401).json({ error: "missing or wrong API key" });
      return;
    }
    next();
  });
  api.post("/reviews", (req, res) => {
    const parsed = ReviewRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid request", issues: parsed.error.issues });
      return;
    }
    const { owner, repo, pullNumber, tasks } = parsed.data;
    const job = options.queue.enqueue({ owner, repo, pullNumber, tasks: tasks ?? options.tasks, trigger: "api" });
    res.status(202).json(job);
  });
  api.get("/jobs", (_req, res) => {
    res.json(options.queue.list());
  });
  api.get("/jobs/:id", (req, res) => {
    const job = options.queue.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "no such job" });
      return;
    }
    res.json(job);
  });
  app.use("/api", api);

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });
  return app;
}
