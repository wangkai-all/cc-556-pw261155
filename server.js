// server.js —— 根入口：node server.js 启动，读取 PORT 环境变量，绑定 127.0.0.1
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './src/store.js';
import { createApp } from './src/serverApp.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dataDir = process.env.DATA_DIR ?? join(__dirname, 'data');
const port = Number(process.env.PORT) || 3000;

const store = createStore(dataDir);
const server = createApp(store);

server.listen(port, '127.0.0.1', () => {
  console.log(`混合单位导入演示服务已启动: http://127.0.0.1:${port}`);
  console.log(`数据目录: ${store.dataDir}`);
});

export { server, store };
