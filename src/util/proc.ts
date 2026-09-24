import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Kills the process and rejects when aborted. */
  signal?: AbortSignal;
}

/** Spawn a process without a shell and collect its output. Never rejects on a non-zero exit code. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      child.kill();
      reject(new Error("cancelled"));
    };
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${cmd} timed out after ${Math.round(opts.timeoutMs! / 1000)}s`));
      }, opts.timeoutMs);
    }
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      if (e.code === "ENOENT") reject(new Error(`Command not found: ${cmd}`));
      else reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    child.stdin.on("error", () => {
      /* child may exit before reading stdin */
    });
    if (opts.input !== undefined) child.stdin.end(opts.input, "utf8");
    else child.stdin.end();
  });
}

/** Run `fn` over `items` with at most `limit` in flight, preserving result order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** A tiny async mutex, used to serialize writes to the antibody store. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async lock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
