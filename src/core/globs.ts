/**
 * Minimal gitignore-style glob matching for `exclude` patterns. ast-grep applies `--globs` only
 * while walking directories, so files named explicitly (hooks, check, MCP tools) are filtered here.
 */

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let g = glob.replace(/\\/g, "/").replace(/\/+$/, "");
  // Like .gitignore: a pattern without a slash matches at any depth; a leading slash anchors it.
  const anchored = g.startsWith("/") || g.slice(0, -1).includes("/");
  g = g.replace(/^\//, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slashAfter = g[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end === -1) re += "\\{";
      else {
        re += `(?:${g.slice(i + 1, end).split(",").map(escape).join("|")})`;
        i = end;
      }
    } else if (c === "[") {
      const end = g.indexOf("]", i);
      if (end === -1) re += "\\[";
      else {
        re += `[${g.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else re += escape(c);
  }
  const out = new RegExp(`^${anchored ? "" : "(?:.*/)?"}${re}$`);
  cache.set(glob, out);
  return out;
}

function escape(s: string): string {
  return s.replace(/[.+^$()|\\/]/g, "\\$&");
}

/**
 * Is `path` (relative to the repository root, forward slashes) excluded by one of `globs`?
 * Accepts ast-grep style negated globs ("!**\/legacy/**") and plain ones. A path is also excluded
 * when one of its parent directories is.
 */
export function isExcluded(path: string, globs: string[]): boolean {
  const patterns = globs.map((g) => g.replace(/^!/, "")).filter(Boolean);
  if (!patterns.length) return false;
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || p === ".") return false;
  const parts = p.split("/");
  for (let i = parts.length; i > 0; i--) {
    const prefix = parts.slice(0, i).join("/");
    if (patterns.some((g) => globToRegExp(g).test(prefix))) return true;
  }
  return false;
}
