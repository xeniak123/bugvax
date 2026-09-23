#!/usr/bin/env node
// Records a real bugvax session (demo -> learn -> fix -> scan) as an asciinema v2 cast.
// Waits for the model are shortened (MAX_IDLE) and output is paced to be readable (MIN_GAP);
// the text itself is exactly what bugvax printed.
// Model answers are cached in scripts/.demo-cache, so re-recording is free while prompts are unchanged.
//   npm run build && node scripts/record-demo.mjs docs/demo.cast
//   npx svg-term-cli --in docs/demo.cast --out docs/demo.svg --window
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "demo.cast");
const cli = resolve("dist/cli.js");
const work = realpathSync(mkdtempSync(join(tmpdir(), "bugvax-rec-")));
const WIDTH = 104;
const HEIGHT = 34;
const MAX_IDLE = 1.0;
const MIN_GAP = 0.5;
const TYPE_DELAY = 0.05;
const CACHE = resolve("scripts/.demo-cache");

const events = [];
let t = 0;
const variants = [work, work.replace(/\\/g, "/"), realpathSync.native(work), realpathSync.native(work).replace(/\\/g, "/")];
const clean = (s) => {
  for (const v of variants) s = s.split(v).join("~");
  return s.replace(/~[\\/]/g, "~/").replace(/\r?\n/g, "\r\n");
};
const emit = (text) => events.push([Number(t.toFixed(3)), "o", clean(text)]);

async function type(cmd) {
  emit("\x1b[1;32m❯\x1b[0m ");
  t += 0.5;
  for (const ch of cmd) {
    t += TYPE_DELAY;
    emit(ch);
  }
  t += 0.4;
  emit("\n");
}

function run(args, cwd) {
  return new Promise((done) => {
    const env = { ...process.env, FORCE_COLOR: "1", GITHUB_ACTIONS: "false", COLUMNS: String(WIDTH - 2), BUGVAX_LLM_CACHE: CACHE };
    delete env.NO_COLOR;
    const child = spawn(process.execPath, [cli, ...args], { cwd, env });
    let last = Date.now();
    const onData = (d) => {
      const now = Date.now();
      t += Math.max(Math.min((now - last) / 1000, MAX_IDLE), args[0] === "learn" ? MIN_GAP : 0.05);
      last = now;
      emit(d.toString("utf8"));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => {
      t += 0.6;
      done(code);
    });
  });
}

const demo = join(work, "demo-shop");
await type("npx bugvax demo && cd demo-shop");
await run(["demo", "demo-shop"], work);
t += 1;
await type("npx bugvax learn");
await run(["learn"], demo);
t += 2;
await type("npx bugvax fix");
await run(["fix"], demo);
t += 1.5;
await type("npx bugvax scan");
await run(["scan"], demo);
t += 4;
emit("");

mkdirSync(dirname(out), { recursive: true });
const header = { version: 2, width: WIDTH, height: HEIGHT, timestamp: Math.floor(Date.now() / 1000), env: { TERM: "xterm-256color", SHELL: "/bin/bash" } };
writeFileSync(out, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n");
console.log(`Recorded ${events.length} events (${t.toFixed(1)}s) to ${out}`);
