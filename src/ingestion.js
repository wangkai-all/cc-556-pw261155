// ingestion.js —— 核心领域逻辑：混合单位导入、规则晚到隔离、补发勘正、追溯与幂等
//
// 设计选择：算后保存（conversion at write time）
//   - 每行同时保存原值(rawQty/rawUnit)与换算值(kgValue)
//   - 换算时把当时命中的规则引用(ruleId/version/effectiveAt)一并钉在行上
//   - 规则表保留全部历史版本；已确认行永久指向旧版本，规则补发不会重算它们
//   因此原值与换算后值都能各自追到“当时的规则”。
import { randomUUID, createHash } from 'node:crypto';

export const KG = 'KG';
export const BOX = 'BOX';
const VALID_UNITS = new Set([KG, BOX]);
const VALID_SOURCES = new Set(['weighing', 'dock']);

// 统一精度，避免二进制浮点噪声（如 0.1+0.2）
export function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

export function naturalKey(row) {
  return `${row.batchId}|${row.source}|${row.ref}`;
}

export function hashContent(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function slugify(productId) {
  return String(productId).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'product';
}

// 找到某商品在指定时刻生效的最新规则（effectiveAt 不晚于该时刻，取最高版本）
export function findApplicableRule(state, productId, at) {
  const candidates = state.rules.filter(
    (r) => r.productId === productId && r.effectiveAt <= at,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, r) => {
    if (r.effectiveAt > best.effectiveAt) return r;
    if (r.effectiveAt === best.effectiveAt && r.version > best.version) return r;
    return best;
  });
}

// 新增或升级规则：同商品再次补发 = 新版本，历史版本保留
export function upsertRule(state, mapping, now) {
  const ruleId = `rule-${slugify(mapping.productId)}`;
  const existing = state.rules
    .filter((r) => r.ruleId === ruleId)
    .sort((a, b) => b.version - a.version);
  const version = existing.length ? existing[0].version + 1 : 1;
  const rule = {
    ruleId,
    productId: mapping.productId,
    productName: mapping.productName ?? existing[0]?.productName ?? mapping.productId,
    fromUnit: BOX,
    toUnit: KG,
    kgPerBox: mapping.kgPerBox,
    version,
    effectiveAt: mapping.effectiveAt ?? now,
    createdAt: now,
    source: mapping.source ?? 'manual-mapping',
  };
  state.rules.push(rule);
  return rule;
}

// 校验一行原始数据；返回 { ok, normalized, reason }
export function validateRawRow(row, index, defaultSource) {
  const prefix = `第 ${index + 1} 行`;
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return { ok: false, reason: `${prefix}: 不是合法对象` };
  }
  const ref = row.ref;
  if (typeof ref !== 'string' || !ref.trim()) {
    return { ok: false, reason: `${prefix}: ref 缺失或不是字符串` };
  }
  const productId = row.productId;
  if (typeof productId !== 'string' || !productId.trim()) {
    return { ok: false, reason: `${prefix}: productId 缺失或不是字符串` };
  }
  const unit = String(row.unit ?? '').trim().toUpperCase();
  if (!VALID_UNITS.has(unit)) {
    return { ok: false, reason: `${prefix}(ref=${ref}): 单位 "${row.unit}" 不受支持，仅允许 KG/BOX` };
  }
  const qty = row.qty;
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) {
    return { ok: false, reason: `${prefix}(ref=${ref}): 数量 qty 必须是大于 0 的数字，收到 ${JSON.stringify(qty)}` };
  }
  const source = String(row.source ?? defaultSource ?? '').trim().toLowerCase();
  if (!VALID_SOURCES.has(source)) {
    return { ok: false, reason: `${prefix}(ref=${ref}): 来源 source 必须是 weighing 或 dock，收到 ${JSON.stringify(row.source ?? defaultSource)}` };
  }
  return {
    ok: true,
    normalized: {
      ref: ref.trim(),
      productId: productId.trim(),
      productName: typeof row.productName === 'string' ? row.productName : productId,
      unit,
      qty,
      source,
    },
  };
}

function totalsOf(rows) {
  const confirmed = rows.filter((r) => r.status === 'confirmed');
  const quarantined = rows.filter((r) => r.status === 'quarantined');
  return {
    totalKg: round4(confirmed.reduce((s, r) => s + r.kgValue, 0)),
    confirmedCount: confirmed.length,
    quarantinedCount: quarantined.length,
    quarantinedBoxes: round4(quarantined.reduce((s, r) => s + r.rawQty, 0)),
  };
}

// 一次导入（可同时含称重文件与码头登记、可混用 KG 与 BOX）
export function importPayload(state, payload, now = new Date().toISOString()) {
  const batchId = typeof payload.batchId === 'string' && payload.batchId.trim()
    ? payload.batchId.trim()
    : `batch-${hashContent(payload).slice(0, 10)}`;
  const contentHash = hashContent({
    batchId,
    defaultSource: payload.defaultSource ?? null,
    rows: payload.rows ?? [],
  });

  const event = {
    id: randomUUID(),
    type: 'import',
    at: now,
    batchId,
    contentHash,
    sourceFile: payload.sourceFile ?? null,
    before: totalsOf(state.rows),
    inserted: 0,
    duplicatesSkipped: 0,
    conflicts: [],
    rejected: [],
    confirmed: 0,
    quarantined: 0,
    skippedAsDuplicate: false,
  };

  // 幂等：同一文件（内容哈希一致）重复上传，整体跳过，不产生任何新行
  const sameHashEvent = state.events.find((e) => e.type === 'import' && e.contentHash === contentHash);
  if (sameHashEvent) {
    event.skippedAsDuplicate = true;
    event.note = `内容哈希 ${contentHash} 已由导入 ${sameHashEvent.batchId} 处理，整批跳过（不重复推送）`;
    event.after = totalsOf(state.rows);
    state.events.push(event);
    return { batchId, contentHash, event, skippedAsDuplicate: true };
  }

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const byKey = new Map(state.rows.map((r) => [r.naturalKey, r]));

  rows.forEach((rawRow, index) => {
    const check = validateRawRow(rawRow, index, payload.defaultSource);
    if (!check.ok) {
      event.rejected.push({ index, raw: rawRow, reason: check.reason });
      state.rejected.push({ batchId, index, raw: rawRow, reason: check.reason, at: now });
      return;
    }
    const n = check.normalized;
    const key = `${batchId}|${n.source}|${n.ref}`;
    const existing = byKey.get(key);
    if (existing) {
      // 同一行重复上传：内容一致 → 跳过；同键不同内容 → 冲突拒收，绝不静默覆盖
      if (existing.rawQty === n.qty && existing.rawUnit === n.unit && existing.productId === n.productId) {
        event.duplicatesSkipped += 1;
      } else {
        const reason = `自然键 ${key} 已存在但内容不同（已有 ${existing.rawQty}${existing.rawUnit}，新到 ${n.qty}${n.unit}），按冲突拒收`;
        event.conflicts.push({ index, naturalKey: key, reason });
        state.rejected.push({ batchId, index, raw: rawRow, reason, at: now });
      }
      return;
    }

    const base = {
      id: randomUUID(),
      naturalKey: key,
      batchId,
      source: n.source,
      ref: n.ref,
      productId: n.productId,
      productName: n.productName,
      rawQty: n.qty,
      rawUnit: n.unit,
      importedAt: now,
      contentHash,
    };

    let row;
    if (n.unit === KG) {
      // 公斤行无需换算，1:1 直接确认
      row = {
        ...base,
        status: 'confirmed',
        kgValue: round4(n.qty),
        ruleRef: { ruleId: null, version: null, effectiveAt: null, basis: 'KG 原值即公斤，无需换算' },
        convertedAt: now,
      };
      event.confirmed += 1;
    } else {
      const rule = findApplicableRule(state, n.productId, now);
      if (!rule) {
        // 规则晚到：先隔离，等待补发单位映射
        row = {
          ...base,
          status: 'quarantined',
          kgValue: null,
          ruleRef: null,
          quarantinedReason: `商品 ${n.productId} 缺少 BOX→KG 单位映射，规则晚到，先行隔离`,
        };
        event.quarantined += 1;
      } else {
        row = {
          ...base,
          status: 'confirmed',
          kgValue: round4(n.qty * rule.kgPerBox),
          ruleRef: {
            ruleId: rule.ruleId,
            version: rule.version,
            effectiveAt: rule.effectiveAt,
            kgPerBox: rule.kgPerBox,
            basis: `按 ${rule.ruleId} v${rule.version}（1 箱=${rule.kgPerBox}kg）换算`,
          },
          convertedAt: now,
        };
        event.confirmed += 1;
      }
    }
    state.rows.push(row);
    byKey.set(key, row);
    event.inserted += 1;
  });

  event.after = totalsOf(state.rows);
  state.events.push(event);
  return { batchId, contentHash, event, skippedAsDuplicate: false };
}

// 补发单位映射：升级规则，只重算“当前仍被隔离”的同商品行；已确认行保持原换算与原规则引用
export function applyMapping(state, mapping, now = new Date().toISOString()) {
  if (!mapping || typeof mapping !== 'object') {
    throw new Error('映射必须是对象 {productId, kgPerBox}');
  }
  if (typeof mapping.productId !== 'string' || !mapping.productId.trim()) {
    throw new Error('mapping.productId 缺失或不是字符串');
  }
  const kgPerBox = mapping.kgPerBox;
  if (typeof kgPerBox !== 'number' || !Number.isFinite(kgPerBox) || kgPerBox <= 0) {
    throw new Error(`mapping.kgPerBox 必须是大于 0 的数字，收到 ${JSON.stringify(kgPerBox)}`);
  }
  if (mapping.unit && String(mapping.unit).trim().toUpperCase() !== BOX) {
    throw new Error(`目前只支持 BOX→KG 映射，收到 unit=${mapping.unit}`);
  }

  const before = totalsOf(state.rows);
  const rule = upsertRule(state, mapping, now);

  const affected = [];
  for (const row of state.rows) {
    if (row.status !== 'quarantined' || row.productId !== rule.productId) continue;
    const beforeKg = row.kgValue;
    row.kgValue = round4(row.rawQty * rule.kgPerBox);
    row.status = 'confirmed';
    row.ruleRef = {
      ruleId: rule.ruleId,
      version: rule.version,
      effectiveAt: rule.effectiveAt,
      kgPerBox: rule.kgPerBox,
      basis: `规则补发后按 ${rule.ruleId} v${rule.version}（1 箱=${rule.kgPerBox}kg）换算`,
    };
    row.convertedAt = now;
    row.correctedAt = now;
    row.quarantinedReason = undefined;
    affected.push({
      naturalKey: row.naturalKey,
      ref: row.ref,
      rawQty: row.rawQty,
      rawUnit: row.rawUnit,
      beforeKg,
      afterKg: row.kgValue,
      ruleRef: row.ruleRef,
    });
  }

  const after = totalsOf(state.rows);
  const event = {
    id: randomUUID(),
    type: 'mapping',
    at: now,
    rule: {
      ruleId: rule.ruleId,
      productId: rule.productId,
      kgPerBox: rule.kgPerBox,
      version: rule.version,
      effectiveAt: rule.effectiveAt,
    },
    before,
    after,
    affectedCount: affected.length,
    affected,
    note: affected.length
      ? `重算 ${affected.length} 行隔离数据并并入合计；此前已确认的行未重新推送/重算`
      : '没有处于隔离状态的匹配行，规则已登记（对后续导入生效），已确认行不受影响',
  };
  state.events.push(event);
  return { rule, affected, before, after, event };
}

// 勘正前后对照视图：把每次映射补发造成的重量变化与行级追溯串起来
export function getResults(state) {
  const mappingEvents = state.events
    .filter((e) => e.type === 'mapping')
    .map((e) => ({
      at: e.at,
      productId: e.rule.productId,
      kgPerBox: e.rule.kgPerBox,
      version: e.rule.version,
      totalKgBefore: e.before.totalKg,
      totalKgAfter: e.after.totalKg,
      deltaKg: round4(e.after.totalKg - e.before.totalKg),
      affectedCount: e.affectedCount,
      affected: e.affected,
      note: e.note,
    }));

  const importEvents = state.events
    .filter((e) => e.type === 'import')
    .map((e) => ({
      at: e.at,
      batchId: e.batchId,
      contentHash: e.contentHash,
      skippedAsDuplicate: Boolean(e.skippedAsDuplicate),
      inserted: e.inserted,
      duplicatesSkipped: e.duplicatesSkipped,
      rejected: e.rejected.length,
      conflicts: e.conflicts.length,
      quarantined: e.quarantined,
      confirmed: e.confirmed,
      totalKgBefore: e.before.totalKg,
      totalKgAfter: e.after.totalKg,
    }));

  return {
    totals: totalsOf(state.rows),
    rows: state.rows.map((r) => ({
      naturalKey: r.naturalKey,
      batchId: r.batchId,
      source: r.source,
      ref: r.ref,
      productId: r.productId,
      productName: r.productName,
      status: r.status,
      rawQty: r.rawQty,
      rawUnit: r.rawUnit,
      kgValue: r.kgValue,
      ruleRef: r.ruleRef,
      importedAt: r.importedAt,
      convertedAt: r.convertedAt ?? null,
      correctedAt: r.correctedAt ?? null,
    })),
    quarantined: state.rows.filter((r) => r.status === 'quarantined').map((r) => ({
      naturalKey: r.naturalKey,
      productId: r.productId,
      ref: r.ref,
      rawQty: r.rawQty,
      rawUnit: r.rawUnit,
      reason: r.quarantinedReason,
    })),
    rules: state.rules.map((r) => ({ ...r })),
    rejected: state.rejected.map((r) => ({ ...r })),
    importEvents,
    corrections: mappingEvents,
  };
}
