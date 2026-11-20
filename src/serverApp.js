// serverApp.js —— HTTP 路由与请求处理（仅 node:http / node:fs，无第三方依赖）
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { importPayload, applyMapping, getResults } from './ingestion.js';
import {
  generateDemoImport,
  initialMappings,
  supplementMappings,
} from './demoData.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function createApp(store) {
  function json(res, status, body) {
    const data = JSON.stringify(body, null, 2);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(data);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('请求体超过 2MB 限制'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.trim()) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('请求体不是合法 JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  // 在可变 state 上执行操作后统一落盘
  function mutate(fn) {
    const state = store.load();
    const result = fn(state);
    store.persist(state);
    return result;
  }

  async function serveStatic(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    // 防目录穿越
    const filePath = join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      json(res, 403, { error: 'forbidden' });
      return;
    }
    try {
      const content = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      res.end(content);
    } catch {
      json(res, 404, { error: 'not found', path: pathname });
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    try {
      if (req.method === 'GET' && url.pathname === '/api/results') {
        json(res, 200, getResults(store.load()));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/reset') {
        const state = store.reset();
        json(res, 200, { ok: true, state: getResults(state).totals });
        return;
      }

      // 通用导入接口：真实功能入口，body 为 {batchId?, defaultSource?, rows:[...]}
      if (req.method === 'POST' && url.pathname === '/api/import') {
        const body = await readBody(req);
        if (!Array.isArray(body.rows)) {
          json(res, 400, { error: 'body.rows 必须是数组' });
          return;
        }
        const result = mutate((state) => importPayload(state, body));
        json(res, 200, { ok: true, ...result, totals: getResults(store.load()).totals });
        return;
      }

      // 通用映射补发接口：body 为单个映射或映射数组
      if (req.method === 'POST' && url.pathname === '/api/mappings') {
        const body = await readBody(req);
        const list = Array.isArray(body) ? body : body.mappings ?? [body];
        const applied = mutate((state) => list.map((m) => applyMapping(state, m)));
        json(res, 200, {
          ok: true,
          applied: applied.map((a) => ({
            rule: a.rule,
            affectedCount: a.affected.length,
            before: a.before,
            after: a.after,
            note: a.event.note,
          })),
          totals: getResults(store.load()).totals,
        });
        return;
      }

      // 演示按钮①：导入混合单位数据（若规则表为空，先登记首批已知映射）
      if (req.method === 'POST' && url.pathname === '/api/demo/import') {
        const result = mutate((state) => {
          if (state.rules.length === 0) {
            for (const m of initialMappings()) applyMapping(state, m);
          }
          return importPayload(state, generateDemoImport());
        });
        json(res, 200, {
          ok: true,
          ...result,
          totals: getResults(store.load()).totals,
        });
        return;
      }

      // 演示按钮②：每次点击补发队列中的下一条映射（无待补发时给出明确提示）
      if (req.method === 'POST' && url.pathname === '/api/demo/supplement') {
        const pending = supplementMappings();
        const output = mutate((state) => {
          const known = new Set(state.rules.map((r) => r.productId));
          const next = pending.find((m) => !known.has(m.productId));
          if (!next) {
            return {
              applied: false,
              message: '所有补发映射均已生效；已确认行不会被重新推送或重算',
              totals: getResults(state).totals,
            };
          }
          const r = applyMapping(state, next);
          return { applied: true, ...r, totals: getResults(state).totals };
        });
        json(res, 200, { ok: true, ...output });
        return;
      }

      if (req.method === 'GET') {
        await serveStatic(req, res);
        return;
      }

      json(res, 404, { error: 'not found', route });
    } catch (err) {
      json(res, 400, { error: err.message ?? String(err) });
    }
  });

  return server;
}

// 同时方便 `node src/serverApp.js` 直接启动
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dataDir = process.env.DATA_DIR;
  const store = createStore(dataDir ?? join(__dirname, '..', 'data'));
  const port = Number(process.env.PORT) || 3000;
  const server = createApp(store);
  server.listen(port, '127.0.0.1', () => {
    console.log(`混合单位导入演示服务已启动: http://127.0.0.1:${port}`);
    console.log(`数据目录: ${store.dataDir}`);
  });
}
