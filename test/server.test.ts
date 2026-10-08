import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, verifySignature } from "../src/server/app.js";
import { JobQueue, type Job, type Worker } from "../src/server/jobs.js";

const SECRET = "shh";
const API_KEY = "key-123";

let server: Server | undefined;
afterEach(() => server?.close());

async function start(worker: Worker = async () => ({}), apiKey: string | null = API_KEY) {
  const queue = new JobQueue(worker);
  const app = createApp({ webhookSecret: SECRET, apiKey: apiKey ?? undefined, tasks: ["review", "test-gap"], queue });
  server = app.listen(0);
  await new Promise((r) => server!.once("listening", r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { queue, base };
}

function sign(body: string, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function webhook(base: string, event: string, payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  return fetch(`${base}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": signature ?? sign(body),
    },
    body,
  });
}

const prEvent = (action: string, draft = false) => ({
  action,
  pull_request: { number: 7, draft },
  repository: { name: "watchdog", owner: { login: "shivaniparimi" } },
});

describe("verifySignature", () => {
  it("accepts GitHub's HMAC and rejects anything else", () => {
    const body = Buffer.from('{"a":1}');
    expect(verifySignature(SECRET, body, sign('{"a":1}'))).toBe(true);
    expect(verifySignature(SECRET, body, sign('{"a":1}', "other"))).toBe(false);
    expect(verifySignature(SECRET, body, "sha256=short")).toBe(false);
    expect(verifySignature(SECRET, body, undefined)).toBe(false);
  });
});

describe("webhooks", () => {
  it("queues a job for opened and updated PRs", async () => {
    const { base, queue } = await start();
    const res = await webhook(base, "pull_request", prEvent("opened"));
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    expect(queue.get(jobId)).toMatchObject({
      owner: "shivaniparimi",
      repo: "watchdog",
      pullNumber: 7,
      trigger: "webhook",
    });
    expect(queue.get(jobId)!.tasks).toEqual(["review", "test-gap"]);
  });

  it("rejects bad or missing signatures", async () => {
    const { base } = await start();
    expect((await webhook(base, "pull_request", prEvent("opened"), sign("tampered"))).status).toBe(401);
    expect((await webhook(base, "pull_request", prEvent("opened"), "")).status).toBe(401);
  });

  it("answers pings and ignores events it doesn't handle", async () => {
    const { base, queue } = await start();
    expect(await (await webhook(base, "ping", { zen: "hi" })).json()).toEqual({ pong: true });
    expect((await webhook(base, "pull_request", prEvent("closed"))).status).toBe(204);
    expect((await webhook(base, "pull_request", prEvent("opened", true))).status).toBe(204); // drafts
    expect((await webhook(base, "issues", { action: "opened" })).status).toBe(204);
    expect(queue.list()).toEqual([]);
  });
});

describe("REST API", () => {
  it("requires the API key", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/jobs`)).status).toBe(401);
    expect((await fetch(`${base}/api/jobs`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${base}/api/jobs`, { headers: { authorization: `Bearer ${API_KEY}` } })).status).toBe(200);
  });

  it("is disabled when no API key is configured", async () => {
    const { base } = await start(async () => ({}), null);
    expect((await fetch(`${base}/api/jobs`)).status).toBe(404);
  });

  it("starts a review on demand, validates input, and reports job status", async () => {
    let release: () => void = () => {};
    const { base } = await start(
      () => new Promise((resolve) => (release = () => resolve({ review: { outputs: { score: 8 } } }))),
    );
    const headers = { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" };

    const bad = await fetch(`${base}/api/reviews`, { method: "POST", headers, body: JSON.stringify({ owner: "a b" }) });
    expect(bad.status).toBe(400);

    const res = await fetch(`${base}/api/reviews`, {
      method: "POST",
      headers,
      body: JSON.stringify({ owner: "o", repo: "r", pullNumber: 3, tasks: ["review"] }),
    });
    expect(res.status).toBe(202);
    const job = (await res.json()) as Job;
    expect(job).toMatchObject({ owner: "o", repo: "r", pullNumber: 3, tasks: ["review"], trigger: "api" });

    release();
    await new Promise((r) => setTimeout(r, 20));
    const done = (await (await fetch(`${base}/api/jobs/${job.id}`, { headers })).json()) as Job;
    expect(done.state).toBe("done");
    expect(done.results).toEqual({ review: { outputs: { score: 8 } } });
    expect((await fetch(`${base}/api/jobs/nope`, { headers })).status).toBe(404);
  });

  it("reports health with job counts", async () => {
    const { base } = await start();
    expect(await (await fetch(`${base}/health`)).json()).toEqual({
      status: "ok",
      jobs: { queued: 0, running: 0, done: 0, failed: 0 },
    });
  });
});

describe("JobQueue", () => {
  it("runs jobs one at a time and records failures", async () => {
    const order: string[] = [];
    let active = 0;
    const queue = new JobQueue(async (job) => {
      active++;
      expect(active).toBe(1);
      order.push(job.repo);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (job.repo === "bad") throw new Error("clone failed");
      return {};
    });
    const a = queue.enqueue({ owner: "o", repo: "a", pullNumber: 1, tasks: ["review"], trigger: "api" });
    const b = queue.enqueue({ owner: "o", repo: "bad", pullNumber: 1, tasks: ["review"], trigger: "api" });
    await queue.idle();
    expect(order).toEqual(["a", "bad"]);
    expect(queue.get(a.id)!.state).toBe("done");
    expect(queue.get(b.id)).toMatchObject({ state: "failed", error: "clone failed" });
  });

  it("merges a newer push into the PR's job that's still waiting", async () => {
    let release: () => void = () => {};
    const queue = new JobQueue(() => new Promise((r) => (release = () => r({}))));
    queue.enqueue({ owner: "o", repo: "busy", pullNumber: 1, tasks: ["review"], trigger: "api" }); // running
    const waiting = queue.enqueue({ owner: "o", repo: "r", pullNumber: 2, tasks: ["review"], trigger: "webhook" });
    const again = queue.enqueue({ owner: "o", repo: "r", pullNumber: 2, tasks: ["test-gap"], trigger: "webhook" });
    expect(again.id).toBe(waiting.id);
    expect(again.tasks).toEqual(["review", "test-gap"]);
    expect(queue.list()).toHaveLength(2);
    release();
    await new Promise((r) => setTimeout(r, 10));
    release();
    await queue.idle();
  });
});
