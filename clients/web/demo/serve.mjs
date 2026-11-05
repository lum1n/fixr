#!/usr/bin/env node
// Zero-dependency static server for the demo: serves clients/web/ so /demo/ can load /dist/.
//   node demo/serve.mjs [--port 8788]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const i = process.argv.indexOf("--port");
const port = Number(i >= 0 ? process.argv[i + 1] : 8788);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".map": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/") path = "/demo/index.html";
  const file = normalize(join(root, path));
  if (!file.startsWith(root) || file.includes("node_modules")) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => console.log(`fixr demo on http://localhost:${port}/demo/`));
