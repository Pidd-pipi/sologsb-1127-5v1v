import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createApp } from '../src/app.js';

let server;
let base;

const LI = { userId: 'u-li', userName: '督导员 李维' };
const WANG = { userId: 'u-wang', userName: '督导员 王岚' };

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

before(async () => {
  const store = createStore(null); // 测试用纯内存库
  const app = createApp(store);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('两人并发认领同一区域：只能一人成功，另一人排队并看到接管人', async () => {
  const [a, b] = await Promise.all([
    api('/api/regions/LC-01/claim', { method: 'POST', body: LI }),
    api('/api/regions/LC-01/claim', { method: 'POST', body: WANG }),
  ]);
  const results = [a.json.result, b.json.result].sort();
  assert.deepEqual(results, ['claimed', 'queued']);

  const queued = a.json.result === 'queued' ? a.json : b.json;
  const claimed = a.json.result === 'claimed' ? a.json : b.json;
  assert.equal(queued.position, 1);
  // 排队者能看到当前接管人
  assert.equal(queued.holder.userId, claimed.region.holder.userId);
  assert.ok(queued.holder.userName);

  // 重复认领幂等：接管人再领一次仍是 claimed
  const again = await api('/api/regions/LC-01/claim', {
    method: 'POST',
    body: { userId: claimed.region.holder.userId, userName: claimed.region.holder.userName },
  });
  assert.equal(again.json.result, 'claimed');
});

test('释放后队首自动接管；退出排队生效', async () => {
  // 李维占 LC-02，王岚排队
  await api('/api/regions/LC-02/claim', { method: 'POST', body: LI });
  const queued = await api('/api/regions/LC-02/claim', { method: 'POST', body: WANG });
  assert.equal(queued.json.result, 'queued');
  assert.equal(queued.json.holder.userName, LI.userName);

  const released = await api('/api/regions/LC-02/release', { method: 'POST', body: LI });
  assert.equal(released.json.newHolder.userId, WANG.userId);

  // 非接管人不能释放
  const forbidden = await api('/api/regions/LC-02/release', { method: 'POST', body: LI });
  assert.equal(forbidden.status, 409);

  // 王岚释放后 LC-02 空置，再排队再退出
  await api('/api/regions/LC-02/release', { method: 'POST', body: WANG });
  await api('/api/regions/LC-02/claim', { method: 'POST', body: LI });
  await api('/api/regions/LC-02/claim', { method: 'POST', body: WANG });
  const left = await api('/api/regions/LC-02/leave', { method: 'POST', body: WANG });
  assert.equal(left.json.region.queue.length, 0);
});

const POINT = {
  id: 'pt-1',
  code: 'WZ-2026-001',
  name: '东四北大街缘石坡道',
  facilityType: '缘石坡道',
  lng: 116.42,
  lat: 39.93,
  district: '东城区',
  location: '东四北大街 12 号',
  builtYear: 2016,
  maintainUnit: '市政道路养护一所',
  createdAt: '2026-09-01T00:00:00.000Z',
};

test('bootstrap 初次上传只补缺不覆盖；无区域编号的旧数据照常合并展示', async () => {
  // 李维先上传（无 regionNo 的旧数据）
  let r = await api('/api/sync/push', {
    method: 'POST',
    body: { ...LI, changes: [{ entity: 'point', op: 'bootstrap', id: POINT.id, pointCode: POINT.code, base: null, data: POINT }] },
  });
  assert.equal(r.json.created, 1);

  // 王岚上传同编号但名称不同的点位：bootstrap 不覆盖
  r = await api('/api/sync/push', {
    method: 'POST',
    body: { ...WANG, changes: [{ entity: 'point', op: 'bootstrap', id: 'pt-other', pointCode: POINT.code, base: null, data: { ...POINT, id: 'pt-other', name: '被改过的名字' } }] },
  });
  assert.equal(r.json.created, 0);
  assert.equal(r.json.remapped.length, 1);
  assert.equal(r.json.remapped[0].serverId, POINT.id);

  const pull = await api('/api/sync/pull');
  const point = pull.json.points.find((p) => p.code === POINT.code);
  assert.equal(point.name, POINT.name);
  assert.equal(point.regionNo, undefined);

  // 旧数据照常进入总览
  const overview = await api('/api/overview');
  assert.equal(overview.json.totalPoints, 1);
  assert.equal(overview.json.hiddenByConflict, 0);
});

test('同一字段两边都改过：保留两份并标出来源，未裁决前不进总览', async () => {
  const basePoint = { ...POINT };
  // 李维改养护单位 → 服务端值
  let r = await api('/api/sync/push', {
    method: 'POST',
    body: {
      ...LI,
      changes: [{ entity: 'point', op: 'update', id: POINT.id, pointCode: POINT.code, base: basePoint, data: { ...POINT, maintainUnit: '城管委设施科' } }],
    },
  });
  assert.equal(r.json.conflicts.length, 0);

  // 王岚基于旧快照也改同一字段 → 冲突
  r = await api('/api/sync/push', {
    method: 'POST',
    body: {
      ...WANG,
      changes: [{ entity: 'point', op: 'update', id: POINT.id, pointCode: POINT.code, base: basePoint, data: { ...POINT, maintainUnit: '园林绿化服务中心' } }],
    },
  });
  assert.equal(r.json.conflicts.length, 1);
  const conflict = r.json.conflicts[0];
  assert.equal(conflict.field, 'maintainUnit');
  assert.equal(conflict.serverValue, '城管委设施科');
  assert.equal(conflict.serverSource.userName, LI.userName);
  assert.equal(conflict.localValue, '园林绿化服务中心');
  assert.equal(conflict.localSource.userName, WANG.userName);
  assert.equal(conflict.status, 'pending');

  // 未裁决前不进总览
  let overview = await api('/api/overview');
  assert.equal(overview.json.totalPoints, 0);
  assert.equal(overview.json.hiddenByConflict, 1);
  assert.equal(overview.json.pendingConflicts, 1);

  // 裁决采用上报值 → 点位回到总览，字段值更新
  const resolved = await api(`/api/conflicts/${conflict.id}/resolve`, {
    method: 'POST',
    body: { ...LI, choice: 'local' },
  });
  assert.equal(resolved.json.conflict.status, 'resolved');
  assert.equal(resolved.json.point.conflictPending, false);

  const pull = await api('/api/sync/pull');
  const point = pull.json.points.find((p) => p.code === POINT.code);
  assert.equal(point.maintainUnit, '园林绿化服务中心');

  overview = await api('/api/overview');
  assert.equal(overview.json.totalPoints, 1);
  assert.equal(overview.json.pendingConflicts, 0);
});

test('不同字段各改各的：互不冲突，各自生效', async () => {
  const basePoint = (await api('/api/sync/pull')).json.points.find((p) => p.code === POINT.code);
  // 李维改位置，王岚改建成年代
  await api('/api/sync/push', {
    method: 'POST',
    body: { ...LI, changes: [{ entity: 'point', op: 'update', id: POINT.id, pointCode: POINT.code, base: basePoint, data: { ...basePoint, location: '东四北大街 20 号' } }] },
  });
  const r = await api('/api/sync/push', {
    method: 'POST',
    body: { ...WANG, changes: [{ entity: 'point', op: 'update', id: POINT.id, pointCode: POINT.code, base: basePoint, data: { ...basePoint, builtYear: 2019 } }] },
  });
  assert.equal(r.json.conflicts.length, 0);

  const point = (await api('/api/sync/pull')).json.points.find((p) => p.code === POINT.code);
  assert.equal(point.location, '东四北大街 20 号');
  assert.equal(point.builtYear, 2019);
});

test('核验与整改按 id 合并；整改字段冲突挂到所属点位', async () => {
  const insp = {
    id: 'ins-1',
    pointId: POINT.id,
    date: '2026-09-20',
    inspector: LI.userName,
    slope: 3.1,
    clearWidth: 140,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    conclusion: '合格',
    problem: '',
    createdAt: '2026-09-20T01:00:00.000Z',
  };
  const rct = {
    id: 'rct-1',
    pointId: POINT.id,
    requirement: '清理坡道口堆物',
    unit: '市政道路养护一所',
    deadline: '2026-10-20',
    recheckDate: '',
    status: '待整改',
    createdAt: '2026-09-20T01:00:00.000Z',
  };
  let r = await api('/api/sync/push', {
    method: 'POST',
    body: {
      ...LI,
      changes: [
        { entity: 'inspection', op: 'create', id: insp.id, pointCode: POINT.code, base: null, data: insp },
        { entity: 'rectify', op: 'create', id: rct.id, pointCode: POINT.code, base: null, data: rct },
      ],
    },
  });
  assert.equal(r.json.created, 2);

  // 王岚离线把整改状态改为「已整改」，李维稍后也改成「复发」→ 冲突
  const baseRct = rct;
  await api('/api/sync/push', {
    method: 'POST',
    body: { ...WANG, changes: [{ entity: 'rectify', op: 'update', id: rct.id, pointCode: POINT.code, base: baseRct, data: { ...rct, status: '已整改', recheckDate: '2026-09-28' } }] },
  });
  r = await api('/api/sync/push', {
    method: 'POST',
    body: { ...LI, changes: [{ entity: 'rectify', op: 'update', id: rct.id, pointCode: POINT.code, base: baseRct, data: { ...rct, status: '复发' } }] },
  });
  assert.equal(r.json.conflicts.length, 1);
  assert.equal(r.json.conflicts[0].entity, 'rectify');
  assert.equal(r.json.conflicts[0].pointCode, POINT.code);

  // 点位因整改冲突被标记，裁决保留服务端后恢复
  const overview = await api('/api/overview');
  assert.equal(overview.json.hiddenByConflict, 1);
  const resolved = await api(`/api/conflicts/${r.json.conflicts[0].id}/resolve`, {
    method: 'POST',
    body: { ...WANG, choice: 'server' },
  });
  assert.equal(resolved.json.point.conflictPending, false);
  const rectify = (await api('/api/sync/pull')).json.rectifies.find((x) => x.id === rct.id);
  assert.equal(rectify.status, '已整改');
});
