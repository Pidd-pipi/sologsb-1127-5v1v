#!/usr/bin/env node
/**
 * 离线核验交接同步服务入口。
 * 零依赖：node server/index.js，默认端口 21828，数据落 data/state.json。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './store.js';
import { createServer } from './http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 21828);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'state.json');

const store = new JsonStore(DATA_FILE);
await store.load();

const server = http.createServer(createServer(store));
server.listen(PORT, () => {
  console.log(`[gbaccessmap-hub] 同步服务已启动: http://0.0.0.0:${PORT}`);
  console.log(`[gbaccessmap-hub] 总库数据文件: ${DATA_FILE}`);
});

// 优雅退出，等待在途写盘完成
const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
