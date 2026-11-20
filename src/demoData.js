// demoData.js —— 可重复生成的一组虚构演示数据
// 使用固定种子的 mulberry32 PRNG：相同种子永远生成完全相同的记录，
// 不依赖 Math.random / Date，便于演示与测试复现。
import { createHash } from 'node:crypto';

export const DEMO_SEED = 'pointwise-delivery-2026';

export function stringHash(str) {
  const h = createHash('sha256').update(str).digest();
  return h.readUInt32BE(0);
}

// 确定性伪随机数生成器（mulberry32）
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRODUCTS = {
  'P-APPLE': '红富士苹果',
  'P-BANANA': '进口香蕉',
  'P-ORANGE': '赣南脐橙',
  'P-GRAPE': '巨峰葡萄',
  'P-MELON': '哈密瓜', // 故意全程不发映射，用于展示持续隔离
};

// 生成一次演示导入：称重文件(weighing) + 码头登记(dock)，KG 与 BOX 混用，
// 另含 2 行异常数据（非法单位、非法数量）与 1 行行内重复数据。
export function generateDemoImport() {
  const rnd = mulberry32(stringHash(DEMO_SEED));
  const qty = (min, max, digits = 2) => {
    const v = min + rnd() * (max - min);
    return Number(v.toFixed(digits));
  };

  const rows = [
    // —— 称重文件 6 行 ——
    { ref: 'W-001', productId: 'P-APPLE', productName: PRODUCTS['P-APPLE'], unit: 'BOX', qty: qty(40, 60, 1), source: 'weighing' },
    { ref: 'W-002', productId: 'P-BANANA', productName: PRODUCTS['P-BANANA'], unit: 'KG', qty: qty(200, 400), source: 'weighing' },
    { ref: 'W-003', productId: 'P-ORANGE', productName: PRODUCTS['P-ORANGE'], unit: 'BOX', qty: qty(30, 50, 1), source: 'weighing' },
    { ref: 'W-004', productId: 'P-GRAPE', productName: PRODUCTS['P-GRAPE'], unit: 'KG', qty: qty(80, 160), source: 'weighing' },
    { ref: 'W-005', productId: 'P-MELON', productName: PRODUCTS['P-MELON'], unit: 'BOX', qty: qty(10, 20, 1), source: 'weighing' },
    { ref: 'W-006', productId: 'P-APPLE', productName: PRODUCTS['P-APPLE'], unit: 'KG', qty: qty(300, 500), source: 'weighing' },

    // —— 码头登记 6 行 ——
    { ref: 'D-001', productId: 'P-BANANA', productName: PRODUCTS['P-BANANA'], unit: 'BOX', qty: qty(20, 40, 1), source: 'dock' },
    { ref: 'D-002', productId: 'P-ORANGE', productName: PRODUCTS['P-ORANGE'], unit: 'KG', qty: qty(150, 300), source: 'dock' },
    { ref: 'D-003', productId: 'P-GRAPE', productName: PRODUCTS['P-GRAPE'], unit: 'BOX', qty: qty(15, 25, 1), source: 'dock' },
    { ref: 'D-004', productId: 'P-MELON', productName: PRODUCTS['P-MELON'], unit: 'BOX', qty: qty(8, 16, 1), source: 'dock' },
    { ref: 'D-005', productId: 'P-APPLE', productName: PRODUCTS['P-APPLE'], unit: 'BOX', qty: qty(25, 45, 1), source: 'dock' },
    { ref: 'D-006', productId: 'P-BANANA', productName: PRODUCTS['P-BANANA'], unit: 'KG', qty: qty(120, 240), source: 'dock' },

    // —— 异常 2 行：应被拒收并记录原因 ——
    { ref: 'W-007', productId: 'P-ORANGE', productName: PRODUCTS['P-ORANGE'], unit: 'PALLET', qty: 12, source: 'weighing' },
    { ref: 'W-008', productId: 'P-GRAPE', productName: PRODUCTS['P-GRAPE'], unit: 'KG', qty: -5, source: 'weighing' },

    // —— 行内重复：与 W-001 同自然键同内容，应计 duplicatesSkipped ——
    { ref: 'W-001', productId: 'P-APPLE', productName: PRODUCTS['P-APPLE'], unit: 'BOX', qty: null, source: 'weighing' },
  ];
  // 复制 W-001 的真实数量，保证“同键同内容”而非手填漂移
  rows[14].qty = rows[0].qty;

  return {
    batchId: 'BATCH-20261121-DEMO',
    sourceFile: 'weighing-and-dock-20261121.csv（虚构）',
    rows,
  };
}

// 首批已知映射（导入前生效）：苹果、香蕉可立即换算
export function initialMappings() {
  return [
    { productId: 'P-APPLE', productName: PRODUCTS['P-APPLE'], kgPerBox: 12.5, source: 'initial-mapping' },
    { productId: 'P-BANANA', productName: PRODUCTS['P-BANANA'], kgPerBox: 8, source: 'initial-mapping' },
  ];
}

// 晚到的映射：分两次补发
export function supplementMappings() {
  return [
    { productId: 'P-ORANGE', productName: PRODUCTS['P-ORANGE'], kgPerBox: 10.4, source: 'late-mapping-1' },
    { productId: 'P-GRAPE', productName: PRODUCTS['P-GRAPE'], kgPerBox: 5.2, source: 'late-mapping-2' },
  ];
}
