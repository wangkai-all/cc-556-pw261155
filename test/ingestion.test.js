// test/ingestion.test.js —— 领域逻辑单测：正常 + 异常全覆盖
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, createEmptyState } from '../src/store.js';
import {
  importPayload,
  applyMapping,
  getResults,
  findApplicableRule,
  validateRawRow,
} from '../src/ingestion.js';
import {
  generateDemoImport,
  initialMappings,
  supplementMappings,
  mulberry32,
  stringHash,
  DEMO_SEED,
} from '../src/demoData.js';

const T0 = '2026-11-21T09:00:00.000Z';
const T1 = '2026-11-21T10:00:00.000Z';
const T2 = '2026-11-21T11:00:00.000Z';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'mix-unit-'));
  return createStore(dir);
}

// 装好首批映射 + 演示导入，返回落盘后的 state
function demoState(store = freshStore()) {
  const state = store.load();
  for (const m of initialMappings()) applyMapping(state, m, T0);
  importPayload(state, generateDemoImport(), T0);
  store.persist(state);
  return { store, state };
}

test('虚构数据可重复生成：固定种子两次生成的数量与内容哈希完全一致', () => {
  const a = generateDemoImport();
  const b = generateDemoImport();
  assert.deepEqual(a, b);
  // 导入侧内容哈希（含 batchId/defaultSource）两次一致，且等于黄金值
  const h1 = importPayload(createEmptyState(), a, T0).contentHash;
  const h2 = importPayload(createEmptyState(), b, T0).contentHash;
  assert.equal(h1, h2);
  assert.equal(h1, 'ff076836f8725be2');
  // PRNG 确定性：相同种子序列一致
  const r1 = mulberry32(stringHash(DEMO_SEED));
  const r2 = mulberry32(stringHash(DEMO_SEED));
  assert.equal(r1(), r2());
  assert.equal(a.rows.length, 15);
});

test('混合单位导入：KG 直接确认，有映射的 BOX 按规则换算，无映射的 BOX 隔离', () => {
  const { state } = demoState();
  const ev = state.events.find((e) => e.type === 'import');
  assert.equal(ev.inserted, 12);
  assert.equal(ev.confirmed, 8);
  assert.equal(ev.quarantined, 4);
  assert.equal(ev.duplicatesSkipped, 1);
  assert.equal(ev.rejected.length, 2);

  const w1 = state.rows.find((r) => r.ref === 'W-001');
  assert.equal(w1.status, 'confirmed');
  assert.equal(w1.rawQty, 55.7);
  assert.equal(w1.kgValue, 696.25); // 55.7 * 12.5
  assert.deepEqual(
    { ruleId: w1.ruleRef.ruleId, version: w1.ruleRef.version, kgPerBox: w1.ruleRef.kgPerBox },
    { ruleId: 'rule-p-apple', version: 1, kgPerBox: 12.5 },
  );

  const w2 = state.rows.find((r) => r.ref === 'W-002'); // KG 行无需规则
  assert.equal(w2.rawUnit, 'KG');
  assert.equal(w2.kgValue, w2.rawQty);
  assert.equal(w2.ruleRef.ruleId, null);

  const melon = state.rows.find((r) => r.ref === 'W-005');
  assert.equal(melon.status, 'quarantined');
  assert.equal(melon.kgValue, null);
  assert.match(melon.quarantinedReason, /缺少/);

  assert.deepEqual(ev.after, {
    totalKg: 2715.77,
    confirmedCount: 8,
    quarantinedCount: 4,
    quarantinedBoxes: 96.5,
  });
});

test('异常数据被拒收：非法单位、非正数量，并保留原因', () => {
  const { state } = demoState();
  const reasons = state.rejected.map((r) => r.reason);
  assert.equal(reasons.length, 2);
  assert.match(reasons[0], /PALLET/);
  assert.match(reasons[1], /-5/);
  assert.equal(state.rows.filter((r) => r.ref === 'W-007').length, 0);

  // 单元化校验器的其他异常
  assert.equal(validateRawRow({ ref: '', productId: 'P1', unit: 'KG', qty: 1 }, 0).ok, false);
  assert.equal(validateRawRow({ ref: 'R', productId: 'P1', unit: 'KG', qty: 'x' }, 1).ok, false);
  assert.equal(validateRawRow({ ref: 'R', productId: 'P1', unit: 'KG', qty: 0 }, 2).ok, false);
  assert.equal(validateRawRow('not-object', 3).ok, false);
  assert.equal(validateRawRow({ ref: 'R', productId: 'P1', unit: 'KG', qty: 1, source: 'satellite' }, 4).ok, false);
});

test('规则晚到后补发：只重算隔离行，已确认行不重新推送且保留旧规则版本', () => {
  const { state } = demoState();
  const w1Before = state.rows.find((r) => r.ref === 'W-001');
  const convertedAtBefore = w1Before.convertedAt;

  const r = applyMapping(state, supplementMappings()[0], T1); // ORANGE 10.4
  assert.equal(r.affected.length, 1);
  assert.equal(r.affected[0].ref, 'W-003');
  assert.equal(r.affected[0].beforeKg, null);
  assert.equal(r.affected[0].afterKg, 431.6); // 41.5 * 10.4
  assert.equal(r.before.totalKg, 2715.77);
  assert.equal(r.after.totalKg, 3147.37);

  // 已确认的苹果行原封不动（连 convertedAt 时间戳都没变）
  const w1After = state.rows.find((r2) => r2.ref === 'W-001');
  assert.equal(w1After.ruleRef.version, 1);
  assert.equal(w1After.kgValue, 696.25);
  assert.equal(w1After.convertedAt, convertedAtBefore);
  assert.equal(w1After.correctedAt, undefined);

  const r2 = applyMapping(state, supplementMappings()[1], T2); // GRAPE 5.2
  assert.equal(r2.affected.length, 1);
  assert.equal(r2.after.totalKg, 3273.21);
  assert.deepEqual(getResults(state).totals, {
    totalKg: 3273.21,
    confirmedCount: 10,
    quarantinedCount: 2,
    quarantinedBoxes: 30.8, // 哈密瓜始终无映射，保持隔离
  });
});

test('同一文件重复上传：整批幂等跳过，行数与合计不变', () => {
  const { store, state } = demoState();
  const rowsBefore = state.rows.length;
  const second = importPayload(state, generateDemoImport(), T1);
  assert.equal(second.skippedAsDuplicate, true);
  assert.equal(second.event.inserted, 0);
  assert.equal(state.rows.length, rowsBefore);
  store.persist(state);
  // 落盘后重新加载再传一次，仍然跳过
  const reloaded = store.load();
  const third = importPayload(reloaded, generateDemoImport(), T2);
  assert.equal(third.skippedAsDuplicate, true);
  assert.equal(reloaded.rows.length, rowsBefore);
});

test('同自然键不同内容按冲突拒收，不静默覆盖', () => {
  const state = createEmptyState();
  const payload = {
    batchId: 'B1',
    rows: [{ ref: 'R1', productId: 'P1', unit: 'KG', qty: 100, source: 'dock' }],
  };
  importPayload(state, payload, T0);
  const conflict = importPayload(
    state,
    { batchId: 'B1', rows: [{ ...payload.rows[0], qty: 200 }] },
    T1,
  );
  assert.equal(conflict.event.conflicts.length, 1);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].rawQty, 100); // 原值保留
});

test('追溯：原值与换算值各自钉住当时规则，规则升级产生新版本且历史版本保留', () => {
  const state = createEmptyState();
  applyMapping(state, { productId: 'P1', kgPerBox: 10 }, T0);
  importPayload(
    state,
    { batchId: 'B1', rows: [{ ref: 'R1', productId: 'P1', unit: 'BOX', qty: 2, source: 'dock' }] },
    T0,
  );
  const row = state.rows[0];
  assert.equal(row.kgValue, 20);
  assert.equal(row.ruleRef.version, 1);
  assert.equal(row.ruleRef.effectiveAt, T0);

  // 规则升级为 v2：老行继续引用 v1，新导入行使用 v2
  applyMapping(state, { productId: 'P1', kgPerBox: 12 }, T1);
  assert.equal(state.rules.length, 2);
  assert.equal(state.rows[0].ruleRef.version, 1);
  assert.equal(state.rows[0].kgValue, 20);

  importPayload(
    state,
    { batchId: 'B2', rows: [{ ref: 'R2', productId: 'P1', unit: 'BOX', qty: 2, source: 'dock' }] },
    T2,
  );
  const row2 = state.rows.find((r) => r.ref === 'R2');
  assert.equal(row2.kgValue, 24);
  assert.equal(row2.ruleRef.version, 2);
  // findApplicableRule 的时间语义：T1 时刻 v2 还不存在
  assert.equal(findApplicableRule(state, 'P1', T0).version, 1);
  assert.equal(findApplicableRule(state, 'P1', T2).version, 2);
});

test('勘正视图给出前后总量、增量与行级 before/after', () => {
  const { state } = demoState();
  applyMapping(state, supplementMappings()[0], T1);
  const view = getResults(state);
  const c = view.corrections.at(-1);
  assert.equal(c.totalKgBefore, 2715.77);
  assert.equal(c.totalKgAfter, 3147.37);
  assert.equal(c.deltaKg, 431.6);
  assert.equal(c.affected[0].rawUnit, 'BOX');
  assert.equal(c.affected[0].afterKg, 431.6);
});

test('补发没有匹配隔离行时：登记规则并明确提示，不改动任何已确认行', () => {
  const { state } = demoState();
  const before = state.rows.length;
  const r = applyMapping(state, { productId: 'P-NEW', kgPerBox: 3 }, T1);
  assert.equal(r.affected.length, 0);
  assert.match(r.event.note, /没有处于隔离/);
  assert.equal(state.rules.at(-1).productId, 'P-NEW');
  assert.equal(state.rows.length, before);
});

test('补发映射的异常入参被拒绝', () => {
  const state = createEmptyState();
  assert.throws(() => applyMapping(state, { productId: 'P1', kgPerBox: 0 }), /大于 0/);
  assert.throws(() => applyMapping(state, { productId: 'P1', kgPerBox: 'x' }), /数字/);
  assert.throws(() => applyMapping(state, { productId: '', kgPerBox: 5 }), /productId/);
  assert.throws(() => applyMapping(state, { productId: 'P1', kgPerBox: 5, unit: 'PALLET' }), /BOX/);
});

test('落盘与重载：隔离/确认/规则历史在重启后完整保留', () => {
  const store = freshStore();
  const state = store.load();
  for (const m of initialMappings()) applyMapping(state, m, T0);
  importPayload(state, generateDemoImport(), T0);
  applyMapping(state, supplementMappings()[0], T1);
  store.persist(state);

  const onDisk = JSON.parse(readFileSync(store.file, 'utf8'));
  assert.equal(onDisk.rows.length, 12);
  assert.equal(onDisk.rules.length, 3);
  const reloaded = store.load();
  assert.equal(getResults(reloaded).totals.totalKg, 3147.37);
  assert.equal(getResults(reloaded).totals.quarantinedCount, 3);
});
