import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/util/proc.js";

const LAUNCHER = resolve(import.meta.dirname, "..", "plugin", "scripts", "bugvax.mjs");

/**
 * The Claude Code plugin's launcher, with a fake `npx` first on PATH that prints the arguments it
 * got and then echoes stdin, so nothing is fetched from npm.
 */
describe("plugin launcher", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bugvax-plugin-"));
    const bin = join(dir, "bin");
    await mkdir(bin);
    const echo = `node -e "process.stdin.pipe(process.stdout)"`;
    await writeFile(join(bin, "npx.cmd"), `@echo args: %*\r\n@${echo}\r\n`);
    await writeFile(join(bin, "npx"), `#!/bin/sh\necho "args: $*"\nexec ${echo}\n`);
    await chmod(join(bin, "npx"), 0o755);
    env = { ...process.env };
    const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    env[key] = `${bin}${delimiter}${env[key] ?? ""}`;

    // A folder that holds a repository using bugvax, and a folder without any.
    await mkdir(join(dir, "work", "shop", ".bugvax"), { recursive: true });
    await mkdir(join(dir, "work", "shop", "src"), { recursive: true });
    await mkdir(join(dir, "plain", "src"), { recursive: true });
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const launch = (cwd: string, args: string[], payload: unknown) =>
    run(process.execPath, [LAUNCHER, ...args], { cwd, env, input: JSON.stringify(payload) });

  it("does not start npx where bugvax is not set up", async () => {
    const plain = join(dir, "plain");
    const res = await launch(plain, ["check", "--hook", "claude-code"], { cwd: plain, tool_input: { file_path: join(plain, "src", "a.ts") } });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("runs bugvax for an edit in a repository inside the session folder, passing the payload through", async () => {
    const work = join(dir, "work");
    const payload = { cwd: work, tool_name: "Edit", tool_input: { file_path: join(work, "shop", "src", "a.ts") } };
    const res = await launch(work, ["check", "--hook", "claude-code"], payload);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("args: --yes bugvax check --hook claude-code");
    expect(res.stdout).toContain(JSON.stringify(payload));
  });

  it("runs the session briefing for a folder that holds a bugvax repository", async () => {
    const work = join(dir, "work");
    const res = await launch(work, ["context", "--hook", "claude-code"], { cwd: work, session_id: "s" });
    expect(res.stdout).toContain("args: --yes bugvax context --hook claude-code");
  });
});
