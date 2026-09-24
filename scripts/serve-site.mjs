#!/usr/bin/env node
// Serves site/ locally for development: node scripts/serve-site.mjs [port]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../site", import.meta.url));
const port = Number(process.argv[2] ?? 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

createServer(async (req, res) => {
  let file;
  try {
    file = join(root, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  const rel = relative(root, file);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`bugvax site on http://localhost:${port}`));
