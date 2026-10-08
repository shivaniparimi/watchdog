import { randomUUID } from "node:crypto";

export type TaskName = "review" | "test-gap";

export interface JobRequest {
  owner: string;
  repo: string;
  pullNumber: number;
  tasks: TaskName[];
  /** What started the job, for the job list. */
  trigger: "webhook" | "api";
}

export interface TaskOutcome {
  outputs: Record<string, string | number>;
  failure?: string;
}

export interface Job extends JobRequest {
  id: string;
  state: "queued" | "running" | "done" | "failed";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  results?: Partial<Record<TaskName, TaskOutcome>>;
  error?: string;
}

export type Worker = (job: Job) => Promise<Partial<Record<TaskName, TaskOutcome>>>;

const MAX_HISTORY = 100;

/**
 * In-memory queue that runs one job at a time (each job clones a repo and calls an AI with a
 * rate-limited key). A newer push to the same PR replaces its still-queued job.
 */
export class JobQueue {
  private readonly jobs = new Map<string, Job>();
  private running = false;

  constructor(private readonly worker: Worker) {}

  enqueue(request: JobRequest): Job {
    for (const job of this.jobs.values()) {
      if (
        job.state === "queued" &&
        job.owner === request.owner &&
        job.repo === request.repo &&
        job.pullNumber === request.pullNumber
      ) {
        job.tasks = [...new Set([...job.tasks, ...request.tasks])];
        return job;
      }
    }
    const job: Job = { ...request, id: randomUUID(), state: "queued", createdAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    this.trim();
    void this.drain();
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()].reverse();
  }

  counts(): Record<Job["state"], number> {
    const counts = { queued: 0, running: 0, done: 0, failed: 0 };
    for (const job of this.jobs.values()) counts[job.state]++;
    return counts;
  }

  /** Resolves once nothing is queued or running (used by tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.running || [...this.jobs.values()].some((j) => j.state === "queued")) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.next(); job; job = this.next()) {
        job.state = "running";
        job.startedAt = new Date().toISOString();
        try {
          job.results = await this.worker(job);
          job.state = "done";
        } catch (err) {
          job.state = "failed";
          job.error = err instanceof Error ? err.message : String(err);
        } finally {
          job.finishedAt = new Date().toISOString();
        }
      }
    } finally {
      this.running = false;
    }
  }

  private next(): Job | undefined {
    return [...this.jobs.values()].find((j) => j.state === "queued");
  }

  private trim(): void {
    const finished = [...this.jobs.values()].filter((j) => j.state === "done" || j.state === "failed");
    for (const job of finished.slice(0, Math.max(0, this.jobs.size - MAX_HISTORY))) this.jobs.delete(job.id);
  }
}
