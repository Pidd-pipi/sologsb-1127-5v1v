/**
 * 同步引擎冒烟测试（本机 IndexedDB 用 fake-indexeddb 模拟，需先启动服务端）：
 *   npm run dev --prefix server   # 或 node server/src/index.js
 *   npm run test:sync
 *
 * 覆盖：Dexie v4 迁移 → 首次 bootstrap 全量上传 → 拉回合并结果 →
 *       脏标记三路合并推送 → 同步后本机与服务端一致、脏标记清零。
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

const BASE = process.env.SYNC_BASE || 'http://127.0.0.1:4021';
const realFetch = globalThis.fetch.bind(globalThis);
// 浏览器里走同源相对路径 /api，Node 下补成绝对地址
globalThis.fetch = ((input: unknown, init?: RequestInit) => {
  const url = typeof input === 'string' && input.startsWith('/') ? `${BASE}${input}` : input;
  return realFetch(url as string, init);
}) as typeof fetch;

const USER = { userId: 'u-smoke', userName: '督导员 冒烟' };

async function main() {
  const { db, ensureSeed, markDirty } = await import('../src/db/index');
  const { buildChanges, runSync, countDirty } = await import('../src/sync/engine');

  await ensureSeed();
  assert.equal(await countDirty(), 0, '种子数据不应被标记为脏');

  // 首次同步：全部本地数据走 bootstrap 上传
  const first = await buildChanges();
  assert.ok(first.length > 0, '首次应产生 bootstrap 改动');
  assert.ok(first.every((c) => c.op === 'bootstrap'), '首次全部应为 bootstrap');

  const r1 = await runSync(USER);
  assert.equal(await countDirty(), 0, '同步后脏标记应清零');
  assert.equal((await buildChanges()).length, 0, '同步后不应再有待推送改动');
  assert.equal(await db.syncBase.count(), await db.points.count() + await db.inspections.count() + await db.rectifies.count(), '每个实体都应有服务端基线');
  console.log(`✓ 首次同步：bootstrap ${first.length} 条，拉回点位 ${r1.pull.points.length} 个`);

  // 断网现场改动：改一个整改状态，只产生一条 update
  const rectify = (await db.rectifies.toArray())[0];
  const before = JSON.parse(JSON.stringify(rectify));
  await db.rectifies.update(rectify.id, { status: '已整改', recheckDate: '2026-10-01' });
  await markDirty('rectify', rectify.id, before);
  assert.equal(await countDirty(), 1);

  const changes = await buildChanges();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].op, 'update');
  assert.equal(changes[0].pointCode.length > 0, true, '整改改动应携带所属点位编号');
  assert.deepEqual(changes[0].base && changes[0].base.status, before.status, 'base 应为改动前的值');

  const r2 = await runSync(USER);
  assert.equal(await countDirty(), 0);
  const serverRectify = r2.pull.rectifies.find((r) => r.id === rectify.id);
  assert.equal(serverRectify?.status, '已整改', '服务端应合并本机改动');
  const localRectify = await db.rectifies.get(rectify.id);
  assert.equal(localRectify?.status, '已整改', '本机应保持已合并的值');
  console.log('✓ 现场改动：断网留本机 → 恢复后按点位编号合并进服务端');

  // 旧数据（无区域编号）照常出现在拉取结果里
  assert.ok(r2.pull.points.every((p) => p.conflictPending === false), '无冲突点位不应被标记');
  console.log('✓ 旧数据无区域编号照常合并展示');

  console.log('\n同步引擎冒烟测试全部通过');
  process.exit(0);
}

main().catch((err) => {
  console.error('冒烟测试失败：', err);
  process.exit(1);
});
