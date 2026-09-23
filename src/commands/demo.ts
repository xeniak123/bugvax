import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { run } from "../util/proc.js";
import { pc } from "../ui.js";

/** Create the demo repository (a small shop whose history contains real-looking bug fixes). */
export async function demoCommand(dir: string): Promise<number> {
  const script = fileURLToPath(new URL("../../scripts/demo-repo.mjs", import.meta.url));
  const target = resolve(dir);
  const res = await run(process.execPath, [script, target]);
  if (res.code !== 0) {
    console.error(pc.red(res.stderr.trim() || res.stdout.trim()));
    return res.code;
  }
  console.log(res.stdout.trim());
  console.log(`\n  Now run:\n    ${pc.bold(`cd ${dir}`)}\n    ${pc.bold("npx bugvax learn")}\n`);
  return 0;
}
