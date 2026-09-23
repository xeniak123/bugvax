import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompleteJSONRequest, CompleteJSONResult, LLMProvider } from "./types.js";

/**
 * Replays model answers from a directory (BUGVAX_LLM_CACHE), recording the ones it has not seen.
 * bugvax prompts are deterministic for a given history, so re-running the same learn (e.g. to
 * re-record the demo) costs no model calls.
 */
export class CachedProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;

  constructor(
    private readonly inner: LLMProvider,
    private readonly dir: string,
  ) {
    this.name = inner.name;
    this.model = inner.model;
  }

  async completeJSON(req: CompleteJSONRequest): Promise<CompleteJSONResult> {
    const key = createHash("sha256").update(JSON.stringify([this.inner.name, this.inner.model, req.system, req.messages, req.schema])).digest("hex");
    const file = join(this.dir, `${key.slice(0, 32)}.json`);
    if (existsSync(file)) return { ...(JSON.parse(await readFile(file, "utf8")) as CompleteJSONResult), costUsd: 0 };
    const res = await this.inner.completeJSON(req);
    await mkdir(this.dir, { recursive: true });
    await writeFile(file, JSON.stringify({ json: res.json, raw: res.raw }, null, 2));
    return res;
  }
}
