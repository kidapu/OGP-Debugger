#!/usr/bin/env node
/**
 * ローカル実行用のサーバー。
 * 取得ロジックは lib/inspect.js（Web 標準のみ）に置き、Workers 版と共有する。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPage, probeImage, describeFetchError, InspectError } from './lib/inspect.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 4321;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new InspectError('リクエストが大きすぎます', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new InspectError('JSON の解析に失敗しました', 400)); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function handleInspect(req, res) {
  const body = await readJsonBody(req);
  sendJson(res, 200, await inspectPage(body));
}

async function handleImage(req, res) {
  const body = await readJsonBody(req);
  const result = await probeImage(body);
  if (!result.ok) {
    // 取得できなかったことも「結果」なので 200 で返し、中身で伝える
    sendJson(res, 200, { error: `${result.meta.status} ${result.meta.statusText}`.trim(), meta: result.meta });
    return;
  }
  res.writeHead(200, {
    'Content-Type': result.meta.contentType || 'application/octet-stream',
    'Content-Length': String(result.bytes.byteLength),
    'Cache-Control': 'no-store',
    'X-Image-Meta': encodeURIComponent(JSON.stringify(result.meta)),
  });
  res.end(Buffer.from(result.bytes));
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = join(PUBLIC_DIR, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const file = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/inspect') return await handleInspect(req, res);
    if (req.method === 'POST' && req.url === '/api/image') return await handleImage(req, res);
    if (req.method === 'POST' && req.url === '/api/render') {
      // JS 実行後の DOM は Cloudflare の Browser Rendering に任せているため、ローカルでは使えない
      return sendJson(res, 501, { error: 'JS レンダリングは Cloudflare Workers にデプロイした版でのみ使えます' });
    }
    if (req.method === 'GET') return await serveStatic(req, res);
    res.writeHead(405).end('Method Not Allowed');
  } catch (err) {
    sendJson(res, err.statusCode ?? 502, { error: describeFetchError(err) });
  }
});

/** 起動と同時に既定のブラウザで開く（NO_OPEN=1 で無効化）。 */
function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* 開けなくても本体の動作には影響しない */ }
}

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Kida OGP Debugger  →  ${url}\n`);
  openBrowser(url);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ポート ${PORT} は使用中です。PORT=8080 を付けて起動し直してください\n`);
    process.exit(1);
  }
  throw err;
});
