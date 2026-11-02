// Локальный статический сервер без зависимостей.
// Вся обработка документов идёт в браузере (src/engine.js); сервер только
// отдаёт файлы интерфейса и, для удобства демонстрации, примеры из папки Documents.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(ROOT, process.env.SAMPLES_DIR ?? 'Documents');
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain', '.svg': 'image/svg+xml' };

function inside(base, p) {
  const rel = path.relative(base, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function sendFile(res, file) {
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': `${TYPES[path.extname(file)] ?? 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  if (p === '/api/samples') {
    try {
      const names = (await fs.readdir(SAMPLES_DIR)).filter((n) => n.toLowerCase().endsWith('.txt')).sort();
      const files = await Promise.all(names.map(async (name) => ({ name, text: await fs.readFile(path.join(SAMPLES_DIR, name), 'utf8') })));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(files));
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `Папка с примерами не найдена: ${SAMPLES_DIR}` }));
    }
    return;
  }

  const target = p === '/' ? path.join(ROOT, 'public', 'index.html') : path.join(ROOT, p);
  const allowed = [path.join(ROOT, 'public'), path.join(ROOT, 'src')].some((base) => inside(base, target));
  if (!allowed) { res.writeHead(404).end('Not found'); return; }
  await sendFile(res, target);
});

server.listen(PORT, () => {
  console.log(`Сверка договоров: http://localhost:${PORT}`);
  console.log(`Примеры для кнопки «Загрузить примеры»: ${SAMPLES_DIR}`);
});
