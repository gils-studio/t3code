import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type JobMode = "draft" | "send";

/**
 * queued -> transcribing -> (draft) done
 *                        -> (send)  sending -> done
 * failed keeps the audio so a retry can never lose it.
 */
export type JobStatus = "queued" | "transcribing" | "sending" | "done" | "failed";

export type JobMeta = {
  readonly mode: JobMode;
  readonly threadId: string;
  readonly language: string;
  /** Draft text typed before the recording; sent ahead of the transcript. */
  readonly prefixText: string;
};

export type Job = JobMeta & {
  readonly id: string;
  readonly status: JobStatus;
  readonly transcript: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastError: string | null;
  /** True once a send started, so a restart checks the thread before sending again. */
  readonly sendStarted: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly acknowledgedAt: number | null;
};

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const isValidJobId = (id: string): boolean => JOB_ID_PATTERN.test(id);

/** One directory per job: audio plus job.json, both replaced atomically. */
export class JobStore {
  private readonly root: string;
  private readonly jobs = new Map<string, Job>();

  constructor(root: string) {
    this.root = root;
  }

  async load(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const job = await this.readJob(entry.name);
      if (job) this.jobs.set(job.id, job);
    }
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  all(): ReadonlyArray<Job> {
    return [...this.jobs.values()];
  }

  /** Jobs ahead of this one, for "still queued" feedback. */
  queuePosition(id: string): number {
    const job = this.jobs.get(id);
    if (!job || job.status !== "queued") return 0;
    return this.all().filter(
      (other) =>
        (other.status === "queued" || other.status === "transcribing") &&
        other.createdAt < job.createdAt,
    ).length;
  }

  audioPath(id: string): string {
    return path.join(this.root, id, "audio.aac");
  }

  workPath(id: string, name: string): string {
    return path.join(this.root, id, name);
  }

  async partialAudioPath(id: string): Promise<string> {
    await fs.mkdir(path.join(this.root, id), { recursive: true });
    return path.join(this.root, id, `upload-${randomUUID()}.part`);
  }

  /** Creates the job only after the audio is on disk; the caller then acknowledges the upload. */
  async create(id: string, meta: JobMeta, partialAudioPath: string, now: number): Promise<Job> {
    const existing = this.jobs.get(id);
    if (existing) {
      await fs.rm(partialAudioPath, { force: true });
      return existing;
    }
    await fs.rename(partialAudioPath, this.audioPath(id));
    const job: Job = {
      ...meta,
      id,
      status: "queued",
      transcript: null,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      sendStarted: false,
      createdAt: now,
      updatedAt: now,
      acknowledgedAt: null,
    };
    await this.persist(job);
    return job;
  }

  async update(id: string, patch: Partial<Job>, now: number): Promise<Job> {
    const current = this.jobs.get(id);
    if (!current) throw new Error(`Unknown job ${id}`);
    const next: Job = { ...current, ...patch, updatedAt: now };
    await this.persist(next);
    return next;
  }

  async remove(id: string): Promise<void> {
    this.jobs.delete(id);
    await fs.rm(path.join(this.root, id), { recursive: true, force: true });
  }

  private async persist(job: Job): Promise<void> {
    const target = path.join(this.root, job.id, "job.json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "w");
    try {
      await handle.writeFile(JSON.stringify(job));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
    this.jobs.set(job.id, job);
  }

  private async readJob(id: string): Promise<Job | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.root, id, "job.json"), "utf8")) as Job;
    } catch {
      // No job.json: an upload that never finished. The phone still holds the audio and retries.
      return null;
    }
  }
}
