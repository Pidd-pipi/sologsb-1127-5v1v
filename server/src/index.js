import { createStore } from './store.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT || 4021);
const DATA_FILE = process.env.DATA_FILE || new URL('../data/db.json', import.meta.url).pathname;

const store = createStore(DATA_FILE);
const app = createApp(store);

const server = app.listen(PORT, () => {
  console.log(`[gbaccessmap-server] 离线核验交接服务已启动，端口 ${PORT}，数据文件 ${DATA_FILE}`);
});

function shutdown() {
  console.log('[gbaccessmap-server] 正在退出，落盘数据…');
  store.saveNow();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
