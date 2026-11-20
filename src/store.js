// store.js —— 基于 JSON 文件的持久化存储（仅使用 Node 内置模块）
// 状态结构见 createEmptyState()。所有写操作立即落盘，保证刷新页面/重启后状态不丢。
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

const STATE_FILE = 'state.json';

export function createEmptyState() {
  return {
    rows: [],        // 导入的称重/登记行（含确认行与隔离行）
    rules: [],       // 单位映射规则，保留全部版本（追溯用）
    events: [],      // 导入快照、规则快照、勘正事件
    rejected: [],    // 校验失败被拒收的原始行
  };
}

export function createStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, STATE_FILE);

  function load() {
    if (!existsSync(file)) return createEmptyState();
    const raw = readFileSync(file, 'utf8');
    if (!raw.trim()) return createEmptyState();
    return { ...createEmptyState(), ...JSON.parse(raw) };
  }

  function persist(state) {
    // 先写临时文件再 rename，避免写入中途崩溃导致 JSON 损坏
    const tmp = join(dataDir, `${STATE_FILE}.tmp`);
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, file);
  }

  function reset() {
    if (existsSync(file)) rmSync(file);
    return createEmptyState();
  }

  return { file, load, persist, reset, get dataDir() { return dataDir; } };
}
