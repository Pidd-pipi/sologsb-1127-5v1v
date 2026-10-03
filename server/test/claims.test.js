import test from 'node:test';
import assert from 'node:assert/strict';
import { claim, release, heartbeat, allAreaViews } from '../claims.js';

function state() {
  return { rev: 0, entities: {}, conflicts: {}, claims: {} };
}
const A = 'A-DC-01';
const liwei = { supervisorId: 'sup-liwei', supervisorName: '督导员 李维', clientId: 'dev-1' };
const wanglan = { supervisorId: 'sup-wanglan', supervisorName: '督导员 王岚', clientId: 'dev-2' };
const chenmo = { supervisorId: 'sup-chenmo', supervisorName: '督导员 陈默', clientId: 'dev-3' };

test('并发领取同一片区：第一人接管，第二人排队并看到接管人', () => {
  const s = state();
  const t = 1_000_000;
  const r1 = claim(s, A, liwei, t);
  const r2 = claim(s, A, wanglan, t + 10);

  assert.equal(r1.status, 'holder');
  assert.equal(r1.view.holder.supervisorId, 'sup-liwei');

  assert.equal(r2.status, 'queued');
  assert.equal(r2.view.queuePosition, 1);
  // 排队者能看到接管人是谁
  assert.equal(r2.view.holder.supervisorName, '督导员 李维');
  assert.equal(r2.view.queue[0].supervisorId, 'sup-wanglan');
});

test('第三人排在第二位', () => {
  const s = state();
  const t = 2_000_000;
  claim(s, A, liwei, t);
  claim(s, A, wanglan, t + 10);
  const r3 = claim(s, A, chenmo, t + 20);
  assert.equal(r3.status, 'queued');
  assert.equal(r3.view.queuePosition, 2);
});

test('接管人释放后，队首自动接管', () => {
  const s = state();
  const t = 3_000_000;
  claim(s, A, liwei, t);
  claim(s, A, wanglan, t + 10);
  claim(s, A, chenmo, t + 20);

  const v = release(s, A, 'sup-liwei', t + 30);
  assert.equal(v.holder.supervisorId, 'sup-wanglan');
  assert.equal(v.queue.length, 1);
  assert.equal(v.queue[0].supervisorId, 'sup-chenmo');
});

test('排队者主动退出队列', () => {
  const s = state();
  const t = 4_000_000;
  claim(s, A, liwei, t);
  claim(s, A, wanglan, t + 10);
  const v = release(s, A, 'sup-wanglan', t + 20);
  assert.equal(v.holder.supervisorId, 'sup-liwei');
  assert.equal(v.queue.length, 0);
});

test('接管心跳过期后队首接管', () => {
  const s = state();
  const t = 5_000_000;
  claim(s, A, liwei, t);
  claim(s, A, wanglan, t + 10);
  // 排队者在 TTL 内持续心跳保活（现场 App 每 2 分钟一次）
  heartbeat(s, A, 'sup-wanglan', t + 4 * 60 * 1000);
  // 李维接管心跳过期（TTL 5 分钟），王岚下一次心跳时自动接管
  heartbeat(s, A, 'sup-wanglan', t + 6 * 60 * 1000);
  const live = allAreaViews(s, t + 6 * 60 * 1000);
  assert.equal(live[A].holder.supervisorId, 'sup-wanglan');
});

test('同一督导员重复领取不产生第二个排队位置，只续期', () => {
  const s = state();
  const t = 6_000_000;
  claim(s, A, liwei, t);
  const again = claim(s, A, liwei, t + 100);
  assert.equal(again.status, 'holder');
  assert.equal(s.claims[A].queue.length, 0);
});
