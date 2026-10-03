/**
 * 端到端：起真实 HTTP 服务，两个客户端「同时」领取同一片区，
 * 验证只有一人成为接管人，另一人排队且响应里带接管人信息。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { JsonStore } from '../store.js';
import { createServer } from '../http.js';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gbhub-'));
const store = new JsonStore(path.join(tmpDir, 'state.json'));
await store.load();
const server = http.createServer(createServer(store));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('HTTP 并发领取：一人接管、一人排队且能看到接管人', async () => {
  const areaCode = 'A-DC-01';
  // 两个请求在同一 tick 发出，服务端靠写入串行化决定 FIFO
  const [r1, r2] = await Promise.all([
    post('/api/areas/claim', { areaCode, supervisorId: 'sup-liwei', supervisorName: '督导员 李维', clientId: 'dev-1' }),
    post('/api/areas/claim', { areaCode, supervisorId: 'sup-wanglan', supervisorName: '督导员 王岚', clientId: 'dev-2' }),
  ]);

  const statuses = [r1.body.status, r2.body.status].sort();
  assert.deepEqual(statuses, ['holder', 'queued']);

  const holderResp = r1.body.status === 'holder' ? r1.body : r2.body;
  const queuedResp = r1.body.status === 'queued' ? r1.body : r2.body;
  // 排队者看到的接管人，必须正是获胜的那一人
  assert.equal(queuedResp.view.holder.supervisorId, holderResp.view.holder.supervisorId);
  assert.equal(queuedResp.view.holder.supervisorName, holderResp.view.holder.supervisorName);
  assert.equal(queuedResp.view.queuePosition, 1);

  const list = await post('/api/areas/heartbeat', { areaCode, supervisorId: 'sup-chenmo', supervisorName: '督导员 陈默', clientId: 'dev-3' });
  // 陈默没领过，心跳结果里他不在队列
  assert.equal(list.body.view.queue.some((c) => c.supervisorId === 'sup-chenmo'), false);

  server.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});
