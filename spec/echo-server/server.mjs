#!/usr/bin/env node
// Zero-dependency stand-in for POST /v1/reports, for client development.
//
//   node spec/echo-server/server.mjs [--port 8787] [--status 201] [--fail-first N]
//                                    [--delay-ms MS] [--out DIR] [--key KEY]
//
// Writes <out>/<id>.json (the report document) and <out>/<id>.<png|jpg>.
// Answers like the Worker: 201 {"id"} on first delivery, 200 on a duplicate id,
// 401 without a bearer token (or with the wrong one when --key is given),
// 400/413/422 on bad input. --status forces a status for every request after
// the --fail-first requests that answer 503.

import { createServer } from "node:http";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const port = Number(opt("port", "8787"));
const forced = opt("status", null);
let failFirst = Number(opt("fail-first", "0"));
const delayMs = Number(opt("delay-ms", "0"));
const outDir = resolve(opt("out", "out"));
const key = opt("key", null);
const MAX_BODY = 2_621_440;
const MAX_IMAGE = 2_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

mkdirSync(outDir, { recursive: true });

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "retry-after",
  });
  res.end(JSON.stringify(body));
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new Error("no boundary");
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  const parts = {};
  let pos = buf.indexOf(boundary);
  while (pos >= 0) {
    pos += boundary.length;
    if (buf.slice(pos, pos + 2).toString() === "--") break;
    pos += 2; // CRLF
    const headEnd = buf.indexOf("\r\n\r\n", pos);
    if (headEnd < 0) throw new Error("bad part");
    const head = buf.slice(pos, headEnd).toString();
    const next = buf.indexOf(boundary, headEnd + 4);
    if (next < 0) throw new Error("unterminated");
    const body = buf.slice(headEnd + 4, next - 2);
    const name = /name="([^"]+)"/i.exec(head)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim();
    if (name) parts[name] = { type, body };
    pos = next;
  }
  return parts;
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type, idempotency-key, x-fixr-sdk",
      "access-control-allow-methods": "POST, OPTIONS",
    });
    return res.end();
  }
  if (req.method !== "POST" || !req.url.startsWith("/v1/reports")) return send(res, 404, { error: "not_found" });

  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    chunks.push(c);
  }
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const stamp = new Date().toISOString();
  const log = (status, extra = "") =>
    console.log(`${stamp} ${status} ${req.headers["idempotency-key"] ?? "-"} ${size}B ${req.headers["user-agent"] ?? ""} ${extra}`);

  if (failFirst > 0) {
    failFirst--;
    log(503, "(fail-first)");
    return send(res, 503, { error: "unavailable" });
  }
  if (forced) {
    log(Number(forced), "(forced)");
    return send(res, Number(forced), { error: "forced" });
  }
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ") || auth.length <= 7 || (key && auth.slice(7) !== key)) {
    log(401);
    return send(res, 401, { error: "unauthorized" });
  }
  if (size > MAX_BODY) {
    log(413);
    return send(res, 413, { error: "too_large" });
  }

  const buf = Buffer.concat(chunks);
  const ct = req.headers["content-type"] ?? "";
  let report, image, mime;
  try {
    if (ct.startsWith("multipart/form-data")) {
      const parts = parseMultipart(buf, ct);
      if (!parts.report) throw new Error("missing report part");
      report = JSON.parse(parts.report.body.toString("utf8"));
      if (parts.screenshot) {
        image = parts.screenshot.body;
        mime = parts.screenshot.type;
      }
    } else if (ct.startsWith("application/json")) {
      report = JSON.parse(buf.toString("utf8"));
      if (report.screenshot) {
        mime = report.screenshot.mime;
        image = Buffer.from(report.screenshot.data, "base64");
        delete report.screenshot;
      }
    } else throw new Error(`unsupported content type ${ct}`);
  } catch (e) {
    log(400, e.message);
    return send(res, 400, { error: "bad_request", detail: e.message });
  }

  const problems = [];
  if (report.schema !== 1) problems.push("schema");
  if (typeof report.id !== "string" || !UUID.test(report.id)) problems.push("id");
  if (typeof report.prompt !== "string" || report.prompt.length < 1 || [...report.prompt].length > 4000) problems.push("prompt");
  if (!report.sdk?.name || !report.sdk?.version) problems.push("sdk");
  if (!report.app?.id) problems.push("app.id");
  if (!["ios", "macos", "web", "linux", "windows"].includes(report.device?.platform)) problems.push("device.platform");
  if (req.headers["idempotency-key"] && req.headers["idempotency-key"] !== report.id) problems.push("idempotency-key");
  if (image && !["image/png", "image/jpeg"].includes(mime)) problems.push("screenshot mime");
  if (image && image.length > MAX_IMAGE) {
    log(413, "image");
    return send(res, 413, { error: "image_too_large" });
  }
  if (problems.length) {
    log(422, problems.join(","));
    return send(res, 422, { error: "invalid_report", detail: problems });
  }

  const jsonPath = join(outDir, `${report.id}.json`);
  if (existsSync(jsonPath)) {
    log(200, "(duplicate)");
    return send(res, 200, { id: report.id, duplicate: true });
  }
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  if (image) writeFileSync(join(outDir, `${report.id}.${mime === "image/png" ? "png" : "jpg"}`), image);
  log(201, image ? `${mime} ${image.length}B` : "no image");
  send(res, 201, { id: report.id });
});

server.listen(port, () => console.log(`fixr echo server on http://localhost:${port}/v1/reports, writing ${outDir}`));
