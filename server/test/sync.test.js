import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from '../store.js';
import { applySync } from '../sync.js';

function state() {
  return emptyState();
}

const liwei = { supervisorId: 'sup-liwei', supervisorName: '督导员 李维', clientId: 'dev-1' };
const wanglan = { supervisorId: 'sup-wanglan', supervisorName: '督导员 王岚', clientId: 'dev-2' };

function syncBody(sup, entities, bases = [], resolutions = []) {
  return {
    ...sup,
    entities: { point: entities.point ?? [], inspection: entities.inspection ?? [], route: entities.route ?? [], rectify: entities.rectify ?? [] },
    bases: Object.fromEntries(bases.map((b) => [`${b._k}:${b.id}`, b])),
    ackResolutions: resolutions,
  };
}

const point = (over = {}) => ({
  id: 'pt-1',
  code: 'WZ-2026-001',
  name: '东单坡道',
  facilityType: '缘石坡道',
  lng: 116.418,
  lat: 39.914,
  district: '东城区',
  location: '路口东侧',
  builtYear: 2016,
  maintainUnit: '市政道路养护一所',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

test('两台设备首次先后同步：基线一致时后者改动干净并入，无冲突', () => {
  const s = state();
  // 李维首次把点位同步上来
  const r1 = applySync(s, syncBody(liwei, { point: [point()] }));
  assert.equal(r1.entities.point.length, 1);

  // 王岚以李维的版本为基线，只改 location
  const base = r1.entities.point[0];
  const r2 = applySync(
    s,
    syncBody(wanglan, { point: [point({ location: '王岚现场新位置' })] }, [{ ...base, _k: 'point' }]),
  );
  assert.equal(r2.entities.point[0].location, '王岚现场新位置');
  assert.equal(r2.conflicts.length, 0);
});

test('两边断网各自改同字段 → 合并保留两份、产生 pending 冲突', () => {
  const s = state();
  const r0 = applySync(s, syncBody(liwei, { point: [point()] }));
  const base = r0.entities.point[0];

  // 李维（在线/先回）改了名称
  applySync(
    s,
    syncBody(liwei, { point: [point({ name: '李维改的名称' })] }, [{ ...base, _k: 'point' }]),
  );
  // 王岚断网期间也改了名称，基线仍是旧版本
  const r2 = applySync(
    s,
    syncBody(wanglan, { point: [point({ name: '王岚改的名称' })] }, [{ ...base, _k: 'point' }]),
  );

  const pending = r2.conflicts.filter((c) => c.status === 'pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].field, 'name');
  assert.equal(pending[0].localValue, '王岚改的名称');
  assert.equal(pending[0].remoteValue, '李维改的名称');
  assert.equal(pending[0].pointCode, 'WZ-2026-001');
});

test('两台设备各自新建同编号点位：按点位编号归并，字段冲突照常保留', () => {
  const s = state();
  // 两台设备本地 id 不同，但点位编号相同
  applySync(s, syncBody(liwei, { point: [point({ id: 'local-a', maintainUnit: '养护一所' })] }));
  const r = applySync(
    s,
    syncBody(wanglan, { point: [point({ id: 'local-b', maintainUnit: '养护二所' })] }),
  );
  assert.equal(r.entities.point.length, 1);
  assert.equal(r.idMap.point['local-a'], 'local-b');
  const pending = r.conflicts.filter((c) => c.status === 'pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].field, 'maintainUnit');
});

test('整改子记录冲突带点位编号，供前端屏蔽总览/地图', () => {
  const s = state();
  const r0 = applySync(s, syncBody(liwei, { point: [point()] }));
  const basePoint = r0.entities.point[0];
  const rectify = {
    id: 'rct-1',
    pointId: 'pt-1',
    requirement: '清退占用',
    unit: '养护一所',
    deadline: '2026-11-01',
    recheckDate: '',
    status: '待整改',
    createdAt: '2026-10-01T00:00:00.000Z',
  };
  applySync(
    s,
    syncBody(liwei, { point: [basePoint], rectify: [rectify] }, [{ ...basePoint, _k: 'point' }]),
  );
  // 李维先回，把整改状态更新为「已整改」（基线为待整改）
  applySync(
    s,
    syncBody(liwei, { rectify: [{ ...rectify, status: '已整改', recheckDate: '2026-10-20' }] }, [
      { ...rectify, _k: 'rectify' },
    ]),
  );
  // 王岚断网期间也在同一字段上更新为「复发」，基线仍为待整改 → 字段冲突
  const r = applySync(
    s,
    syncBody(wanglan, { rectify: [{ ...rectify, status: '复发' }] }, [
      { ...rectify, _k: 'rectify' },
    ]),
  );
  const c = r.conflicts.find((x) => x.kind === 'rectify' && x.status === 'pending');
  assert.ok(c);
  assert.equal(c.pointCode, 'WZ-2026-001');
  assert.equal(c.entityName, '东单坡道');
});

test('裁决后冲突 resolved，裁决值落为权威值', () => {
  const s = state();
  const r0 = applySync(s, syncBody(liwei, { point: [point()] }));
  const base = r0.entities.point[0];
  applySync(s, syncBody(liwei, { point: [point({ name: '李维名称' })] }, [{ ...base, _k: 'point' }]));
  const r2 = applySync(
    s,
    syncBody(wanglan, { point: [point({ name: '王岚名称' })] }, [{ ...base, _k: 'point' }]),
  );
  const conflict = r2.conflicts.find((c) => c.status === 'pending');
  const r3 = applySync(
    s,
    syncBody(liwei, {}, [], [{ conflictId: conflict.id, value: '最终裁定名称' }]),
  );
  assert.equal(r3.entities.point[0].name, '最终裁定名称');
  assert.equal(r3.conflicts.find((c) => c.id === conflict.id).status, 'resolved');
});
