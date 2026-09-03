import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_ROOT = path.join(REPO_ROOT, 'app', 'dist');
const HOST = '127.0.0.1';
const PORT = 4175;
const rootVercel = path.join(REPO_ROOT, 'vercel.json');
const vercel = JSON.parse(readFileSync(
  existsSync(rootVercel) ? rootVercel : path.join(REPO_ROOT, 'public-staging', 'vercel.json'),
  'utf8',
));

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

function fileForRequest(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, `http://${HOST}`).pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = path.resolve(BUILD_ROOT, relative);
  const insideBuild = candidate === BUILD_ROOT || candidate.startsWith(`${BUILD_ROOT}${path.sep}`);
  if (!insideBuild || !existsSync(candidate) || !statSync(candidate).isFile()) return null;
  return { candidate, pathname: pathname === '/' ? '/index.html' : pathname };
}

function responseHeaders(pathname) {
  const headers = new Map([['Cache-Control', 'no-store']]);
  for (const rule of vercel.headers ?? []) {
    if (rule.source !== '/(.*)' && rule.source !== pathname) continue;
    for (const entry of rule.headers ?? []) headers.set(entry.key, entry.value);
  }
  return Object.fromEntries(headers);
}

const server = createServer((request, response) => {
  const resolved = fileForRequest(request.url || '/');
  if (!resolved) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    ...responseHeaders(resolved.pathname),
    'Content-Type': contentTypes.get(path.extname(resolved.candidate)) || 'application/octet-stream',
  });
  createReadStream(resolved.candidate).pipe(response);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`public candidate server listening on http://${HOST}:${PORT}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
