/**
 * HTTP 路由（零依赖，基于 node:http）。
 * 所有写操作经 JsonStore.mutate 串行化，保证「并发领取只有一人成功」。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './store.js';
import { applySync, snapshot } from './sync.js';
import { claim, release, heartbeat, areaView, allAreaViews } from './claims.js';
import { AREAS, SUPERVISORS } from '../shared/areas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../frontend/dist');

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(raw ? JSON.parse(raw) : {});
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    // SPA 兜底
    try {
      const index = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(index);
    } catch {
      send(res, 404, { error: 'not found' });
    }
  }
}

export function createServer(store) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      // ---------- 元数据 ----------
      if (req.method === 'GET' && pathname === '/api/meta') {
        send(res, 200, { areas: AREAS, supervisors: SUPERVISORS, serverTime: Date.now() });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        send(res, 200, { ok: true, rev: store.state.rev });
        return;
      }

      // ---------- 区域领取 ----------
      if (req.method === 'GET' && pathname === '/api/areas') {
        // 只读：过期记录在内存视图中清理，不触发持久化与 rev 递增
        const now = Date.now();
        const live = allAreaViews(store.state, now);
        const views = {};
        for (const code of Object.keys(live)) views[code] = areaView(store.state, code, now);
        send(res, 200, { areas: views });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/areas/claim') {
        const body = await readBody(req);
        if (!body.areaCode || !body.supervisorId) {
          send(res, 400, { error: '缺少 areaCode / supervisorId' });
          return;
        }
        let result;
        await store.mutate(async (s) => {
          result = claim(s, body.areaCode, body, Date.now());
        });
        send(res, 200, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/areas/release') {
        const body = await readBody(req);
        let view;
        await store.mutate(async (s) => {
          view = release(s, body.areaCode, body.supervisorId, Date.now());
        });
        send(res, 200, { view });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/areas/heartbeat') {
        const body = await readBody(req);
        let view;
        await store.mutate(async (s) => {
          view = heartbeat(s, body.areaCode, body.supervisorId, Date.now());
        });
        send(res, 200, { view });
        return;
      }

      // ---------- 同步合并 ----------
      if (req.method === 'POST' && pathname === '/api/sync') {
        const body = await readBody(req);
        if (!body.supervisorId || !body.clientId) {
          send(res, 400, { error: '缺少 supervisorId / clientId' });
          return;
        }
        let result;
        await store.mutate(async (s) => {
          result = applySync(s, body);
        });
        // 附带最新领取状态，前端一次拿全
        const now = Date.now();
        const claims = {};
        for (const code of Object.keys(store.state.claims)) {
          claims[code] = areaView(store.state, code, now);
        }
        send(res, 200, { ...result, claims, areas: AREAS, supervisors: SUPERVISORS });
        return;
      }

      // ---------- 演示用：重置总库 ----------
      if (req.method === 'POST' && pathname === '/api/admin/reset') {
        await store.mutate(async (s) => {
          const fresh = new JsonStore('').state;
          s.entities = fresh.entities;
          s.conflicts = fresh.conflicts;
          s.claims = fresh.claims;
        });
        send(res, 200, { ok: true });
        return;
      }

      if (pathname.startsWith('/api/')) {
        send(res, 404, { error: '接口不存在' });
        return;
      }

      // ---------- 静态资源（同进程托管前端构建产物，docker 之外可直接跑） ----------
      await serveStatic(req, res);
    } catch (e) {
      send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };
}
