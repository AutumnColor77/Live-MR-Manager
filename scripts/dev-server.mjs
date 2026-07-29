#!/usr/bin/env node
/**
 * dev-server.mjs — 개발용 정적 파일 서버 (의존성 0, Node 내장 http만 사용).
 *
 * 이전에는 `npm run dev`가 `npx -y serve`를 썼는데, npx가 실행할 때마다
 * 네트워크로 `serve` 패키지를 확인/설치하느라 dev 서버가 뜨는 데 오래 걸렸다
 * (`tauri dev`는 이 서버가 준비될 때까지 기다리므로 앱 실행 전체가 지연됨).
 * 여기서는 외부 패키지 없이 즉시 뜨는 서버로 대체한다. `serve`가 하던 clean-URL
 * 리다이렉트(쿼리스트링을 떨구던 동작)도 하지 않아 ?hover=1 같은 파라미터가
 * 그대로 유지된다.
 *
 * 사용: node scripts/dev-server.mjs [--port 1420] [--root src]
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
// `serve src -l 1420` 형태의 위치 인자도 관대하게 받아준다.
const positional = args.filter((a) => !a.startsWith('-'));
const PORT = Number(getArg('-l', getArg('--port', process.env.PORT || 1420)));
const ROOT_ARG = getArg('--root', positional[0] || 'src');

const projectRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const ROOT = join(projectRoot, ROOT_ARG);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

async function resolveFile(pathname) {
  // 쿼리/해시는 이미 http 파서가 제거. 경로 정규화로 상위 디렉터리 탈출 차단.
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  let full = join(ROOT, safe);
  if (!full.startsWith(ROOT)) return null; // 루트 밖 접근 거부

  try {
    const s = await stat(full);
    if (s.isDirectory()) full = join(full, 'index.html');
    return full;
  } catch {
    // 확장자가 없으면 .html을 붙여 한 번 더 시도(clean URL 편의).
    if (!extname(full)) {
      try {
        await stat(full + '.html');
        return full + '.html';
      } catch { /* fallthrough */ }
    }
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const file = await resolveFile(url.pathname);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 ' + err.message);
  }
});

server.listen(PORT, () => {
  console.log(`[dev-server] serving ${ROOT_ARG}/ at http://localhost:${PORT}`);
});
