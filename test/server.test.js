// test/server.test.js —— HTTP 集成测试：真实启动子进程服务，覆盖接口正常与异常路径
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

let origin;
let child;
let dataDir;

before(async () => {
  const port = await freePort();
  dataDir = await mkdtemp(join(tmpdir(), 'mix-unit-http-'));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
  });
  // 等待端口真正可连
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      const res = await fetch(`${origin}/api/results`);
      if (res.ok) break;
    } catch { /* 尚未起来，重试 */ }
    if (Date.now() > deadline) throw new Error('测试服务启动超时');
    await new Promise((r) => setTimeout(r, 80));
  }
});

after(async () => {
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
  await rm(dataDir, { recursive: true, force: true });
});

async function post(path, body) {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('空目录初始态：合计为 0、无行无规则', async () => {
  const res = await fetch(`${origin}/api/results`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.totals, {
    totalKg: 0, confirmedCount: 0, quarantinedCount: 0, quarantinedBoxes: 0,
  });
  assert.equal(data.rows.length, 0);
  assert.equal(data.rules.length, 0);
});

test('页面与静态资源可访问，且业务结果区带 data-evidence-result', async () => {
  const html = await (await fetch(`${origin}/`)).text();
  assert.match(html, /导入混合单位数据/);
  assert.match(html, /补发单位映射/);
  assert.match(html, /查勘正前后的重量/);
  for (const name of ['summary', 'import-result', 'mapping-result', 'weight-result']) {
    assert.match(html, new RegExp(`data-evidence-result="${name}"`));
  }
});

test('① 演示导入：8 确认 / 4 隔离 / 1 重复跳过 / 2 拒收', async () => {
  const res = await post('/api/demo/import', {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.event.inserted, 12);
  assert.equal(data.event.quarantined, 4);
  assert.equal(data.event.duplicatesSkipped, 1);
  assert.equal(data.event.rejected.length, 2);
  assert.equal(data.totals.totalKg, 2715.77);
  assert.equal(data.totals.quarantinedCount, 4);
});

test('① 重复上传同一文件：整批跳过且总量不变（幂等）', async () => {
  const before = await (await fetch(`${origin}/api/results`)).json();
  const res = await post('/api/demo/import', {});
  const data = await res.json();
  assert.equal(data.skippedAsDuplicate, true);
  const after = await (await fetch(`${origin}/api/results`)).json();
  assert.equal(after.rows.length, before.rows.length);
  assert.equal(after.totals.totalKg, before.totals.totalKg);
});

test('通用 /api/import 异常路径：rows 不是数组 400', async () => {
  const res = await post('/api/import', { rows: 'nope' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /rows 必须是数组/);
});

test('通用 /api/import：自定义批次混用单位，无映射 BOX 隔离', async () => {
  const res = await post('/api/import', {
    batchId: 'CUSTOM-1',
    rows: [
      { ref: 'C1', productId: 'P-APPLE', unit: 'box', qty: 10, source: 'dock' },   // 小写单位归一化
      { ref: 'C2', productId: 'P-APPLE', unit: 'KG', qty: 50, source: 'dock' },
      { ref: 'C3', productId: 'P-MELON', unit: 'BOX', qty: 3, source: 'weighing' }, // 无映射隔离
    ],
  });
  const data = await res.json();
  assert.equal(data.event.inserted, 3);
  assert.equal(data.event.quarantined, 1);
  const results = await (await fetch(`${origin}/api/results`)).json();
  const c1 = results.rows.find((r) => r.ref === 'C1');
  assert.equal(c1.kgValue, 125); // 10 * 12.5
});

test('② 补发映射：隔离行重算并入合计，已确认行不动', async () => {
  const res = await post('/api/demo/supplement', {});
  const data = await res.json();
  assert.equal(data.applied, true);
  assert.equal(data.rule.productId, 'P-ORANGE');
  assert.equal(data.affected.length, 1);
  assert.equal(data.before.totalKg, data.after.totalKg - 431.6);
});

test('② 再补发一条：葡萄行勘正，哈密瓜继续隔离', async () => {
  const res = await post('/api/demo/supplement', {});
  const data = await res.json();
  assert.equal(data.rule.productId, 'P-GRAPE');
  // 演示批次 2 行哈密瓜 + 自定义批次 1 行哈密瓜(C3) 仍隔离
  assert.equal(data.after.quarantinedCount, 3);
  assert.equal(data.after.totalKg, 3273.21 + 125 + 50); // 演示基线 + 自定义批次的苹果125+KG50
});

test('② 补发队列耗尽：明确提示而非报错，已确认行不重算', async () => {
  const res = await post('/api/demo/supplement', {});
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.applied, false);
  assert.match(data.message, /不会被重新推送/);
});

test('③ 勘正前后对照：corrections 含每次总量前后值与增量，行级规则可追溯', async () => {
  const data = await (await fetch(`${origin}/api/results`)).json();
  assert.ok(data.corrections.length >= 2);
  const orange = data.corrections.find((c) => c.productId === 'P-ORANGE');
  assert.equal(orange.deltaKg, 431.6);
  assert.equal(orange.affected[0].ruleRef.version, 1);
  // 哈密瓜始终无映射：演示 2 行 + 自定义批次 C3，保持隔离
  assert.deepEqual(data.quarantined.map((q) => q.ref).sort(), ['C3', 'D-004', 'W-005']);
  // 每行同时有原值与（确认行的）换算值及规则引用
  const w1 = data.rows.find((r) => r.ref === 'W-001');
  assert.equal(w1.rawQty, 55.7);
  assert.equal(w1.rawUnit, 'BOX');
  assert.equal(w1.kgValue, 696.25);
  assert.equal(w1.ruleRef.ruleId, 'rule-p-apple');
});

test('异常请求：非法 JSON 返回 400，未知路由返回 404', async () => {
  const bad = await fetch(`${origin}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /JSON/);

  const nf = await fetch(`${origin}/api/nope`);
  assert.equal(nf.status, 404);
});

test('通用映射接口异常入参：kgPerBox 非法返回 400', async () => {
  const res = await post('/api/mappings', { productId: 'P-X', kgPerBox: -1 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /大于 0/);
});

test('重置接口：回到空目录初始态', async () => {
  const res = await post('/api/reset', {});
  const data = await res.json();
  assert.equal(data.ok, true);
  const results = await (await fetch(`${origin}/api/results`)).json();
  assert.equal(results.rows.length, 0);
  assert.equal(results.totals.totalKg, 0);
});
