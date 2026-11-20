# 混合单位称重数据导入与勘正演示

接收**称重文件（weighing）**与**码头登记（dock）**两批数据，同一次导入中可混用
**公斤（KG）**与**箱（BOX）**。当 BOX→KG 的换算规则晚到时，无法确定的行先**隔离**，
补发单位映射后只重算隔离行并合并合计；已经确认的行不会被重新推送或重算。

仅依赖 Node.js 内置模块（`node:http` / `node:fs` / `node:crypto` 等），无第三方依赖。

## 启动

```bash
node server.js            # 默认端口 3000
PORT=8080 node server.js  # 读取 PORT 环境变量
```

服务固定绑定 `127.0.0.1`，打开 http://127.0.0.1:3000 即可使用页面。
数据落盘在 `DATA_DIR`（默认 `./data/state.json`），页面上另有「重置数据」按钮可回到空目录初始态。

## 页面三个功能（真实接口，非假数据）

| 按钮 | 接口 | 行为 |
| --- | --- | --- |
| 导入混合单位数据 | `POST /api/demo/import` | 导入一组可重复生成的虚构记录：12 行有效（weighing+dock、KG+BOX 混用）、2 行异常、1 行行内重复；无映射的 BOX 行进隔离区 |
| 补发单位映射 | `POST /api/demo/supplement` | 每次补发一条晚到的 BOX→KG 映射，只重算当前仍隔离的同商品行 |
| 查勘正前后的重量 | `GET /api/results` | 每次勘正的总量前后值/增量、逐行原值→公斤值与规则版本追溯、隔离与拒收明细 |

页面业务结果区均带 `data-evidence-result` 属性（`summary` / `import-result` /
`mapping-result` / `weight-result`），便于核对操作前后的内容。

另外提供通用接口，可脱离演示数据使用：

- `POST /api/import`：body `{ "batchId": "...", "defaultSource"?: "weighing"|"dock", "rows": [...] }`
- `POST /api/mappings`：body 为单个映射 `{productId, kgPerBox}` 或 `{ "mappings": [...] }`
- `POST /api/reset`：清空落盘状态

## 关键设计决策

### 1. 算后保存（conversion at write time），而非读时换算

换算发生时就把结果与当时规则引用一起钉在每行上并落盘：

```jsonc
{
  "rawQty": 55.7, "rawUnit": "BOX",        // 原值原样保留
  "kgValue": 696.25,                        // 换算后值，落盘固化
  "ruleRef": { "ruleId": "rule-p-apple", "version": 1,
               "effectiveAt": "2026-...", "kgPerBox": 12.5 },
  "status": "confirmed"
}
```

规则表保留全部历史版本。规则后来升级（v2、v3…）时，老行仍指向自己换算时的 v1，
新导入行才用新版本——**原值和换算后值都能各自追到“当时的规则”**，且无需在读取路径上
猜测该用哪版规则。KG 行 1:1 直接确认，`ruleRef.ruleId` 为 `null` 并注明无需换算。

### 2. 规则晚到 → 先隔离，识别后重算合并

- BOX 行导入时找不到生效规则 → `status=quarantined`、`kgValue=null`、记录隔离原因，**不进合计**。
- 补发映射后，仅扫描当前仍 `quarantined` 的同商品行进行重算、确认并并入合计。
- 已确认行（包括按旧版本规则换算的行）原样保留，不重新推送、不重算。
- 演示中哈密瓜 `P-MELON` 始终不发映射，用于展示持续隔离状态。

### 3. 同一行/同一文件重复上传的幂等

- **文件级**：导入内容做 sha256 哈希；同哈希再次上传，整批跳过（事件里留痕），合计不变。
- **行级**：自然键 `batchId|source|ref`。同键同内容 → 计 `duplicatesSkipped`；
  同键但数量/单位/商品不同 → 按**冲突拒收**并记录原因，绝不静默覆盖。
- 异常行（非法单位、非正数量、缺字段等）直接拒收并保留原始内容与原因。

### 4. 可重复生成的虚构数据

`src/demoData.js` 使用固定种子（mulberry32 PRNG + sha256 种子），不依赖
`Math.random`/当前时间，任意机器、任意时刻生成的 15 行数据完全一致，
导入内容哈希稳定为 `ff076836f8725be2`，演示黄金值：

| 阶段 | 确认行 | 隔离行 | 合计 kg |
| --- | --- | --- | --- |
| 首次导入后 | 8 | 4（96.5 箱） | 2715.77 |
| 补发脐橙 10.4 kg/箱 | 9 | 3 | 3147.37（+431.6） |
| 补发葡萄 5.2 kg/箱 | 10 | 2（30.8 箱，哈密瓜） | 3273.21（+125.84） |

## 测试

```bash
node --test
```

- `test/ingestion.test.js`：领域单测——混合单位换算、规则晚到隔离、补发只重算隔离行、
  已确认行钉住旧规则版本、规则升级多版本、文件/行级重复上传、冲突拒收、异常入参、落盘重载。
- `test/server.test.js`：真实子进程启动 HTTP 服务（临时端口、临时 DATA_DIR），
  覆盖三个演示按钮对应接口的正常与异常路径、非法 JSON、404、页面 `data-evidence-result` 标记与重置。

## 目录结构

```
server.js              # 根入口：读 PORT、绑 127.0.0.1
src/
  serverApp.js         # HTTP 路由
  ingestion.js         # 导入/隔离/换算/勘正/追溯核心逻辑
  store.js             # JSON 文件持久化（原子写入）
  demoData.js          # 固定种子虚构数据
public/index.html      # 单页界面（原生 JS，无依赖）
test/                  # node:test 用例
data/state.json        # 运行期生成，已 gitignore
```
