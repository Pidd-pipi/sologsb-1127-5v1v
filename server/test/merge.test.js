import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEntity, sameValue, resolveConflict, computePendingSet } from '../../shared/merge.js';

const now = '2026-10-03T00:00:00.000Z';
const local = { supervisorId: 'sup-a', supervisorName: '督导员甲', clientId: 'dev-a', at: now };
const remote = { supervisorId: 'sup-b', supervisorName: '督导员乙', clientId: 'dev-b', at: now };

function point(over = {}) {
  return {
    id: 'pt-1',
    code: 'WZ-2026-001',
    name: '测试坡道',
    location: '路口东侧',
    ...over,
  };
}

test('现场改、总库没改：直接采用现场值', () => {
  const r = mergeEntity({
    kind: 'point',
    server: point({ location: '路口东侧' }),
    client: point({ location: '现场新位置' }),
    base: point({ location: '路口东侧' }),
    pointCode: 'WZ-2026-001',
    entityName: '测试坡道',
    conflictSeq: 1,
    localSource: local,
    remoteSource: remote,
    now,
  });
  assert.equal(r.merged.location, '现场新位置');
  assert.equal(r.conflicts.length, 0);
  assert.deepEqual(r.changedFields, ['location']);
});

test('总库改、现场没改：保留总库值', () => {
  const r = mergeEntity({
    kind: 'point',
    server: point({ location: '总库新位置' }),
    client: point({ location: '路口东侧' }),
    base: point({ location: '路口东侧' }),
    pointCode: 'WZ-2026-001',
    entityName: '测试坡道',
    conflictSeq: 1,
    localSource: local,
    remoteSource: remote,
    now,
  });
  assert.equal(r.merged.location, '总库新位置');
  assert.equal(r.conflicts.length, 0);
});

test('同一字段两边都改且值不同：两份都保留、标出来源、产生 pending 冲突', () => {
  const r = mergeEntity({
    kind: 'point',
    server: point({ location: '总库改写' }),
    client: point({ location: '现场改写' }),
    base: point({ location: '路口东侧' }),
    pointCode: 'WZ-2026-001',
    entityName: '测试坡道',
    conflictSeq: 1,
    localSource: local,
    remoteSource: remote,
    now,
  });
  assert.equal(r.conflicts.length, 1);
  const c = r.conflicts[0];
  assert.equal(c.status, 'pending');
  assert.equal(c.field, 'location');
  assert.equal(c.localValue, '现场改写');
  assert.equal(c.remoteValue, '总库改写');
  assert.equal(c.localSource.supervisorName, '督导员甲');
  assert.equal(c.remoteSource.supervisorName, '督导员乙');
  // 未裁决前沿用总库原值（不会把现场值悄悄当权威）
  assert.equal(r.merged.location, '总库改写');
});

test('两边改同一字段但值相同：不产生冲突', () => {
  const r = mergeEntity({
    kind: 'point',
    server: point({ location: '一致的新值' }),
    client: point({ location: '一致的新值' }),
    base: point({ location: '路口东侧' }),
    pointCode: 'WZ-2026-001',
    entityName: '测试坡道',
    conflictSeq: 1,
    localSource: local,
    remoteSource: remote,
    now,
  });
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.merged.location, '一致的新值');
});

test('无基线（首次同步）的新建实体不产生冲突', () => {
  const r = mergeEntity({
    kind: 'point',
    server: null,
    client: point(),
    base: null,
    pointCode: 'WZ-2026-001',
    entityName: '测试坡道',
    conflictSeq: 1,
    localSource: local,
    remoteSource: remote,
    now,
  });
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.merged.code, 'WZ-2026-001');
});

test('多字段混合：一部分干净合并，一部分冲突', () => {
  const r = mergeEntity({
    kind: 'point',
    server: point({ name: '总库改名', location: '路口东侧', maintainUnit: '总库单位' }),
    client: point({ name: '现场改名', location: '现场新位置', maintainUnit: '城管委设施科' }),
    base: point({ name: '测试坡道', location: '路口东侧', maintainUnit: '城管委设施科' }),
    pointCode: 'WZ-2026-001',
    entityName: '测试坡道',
    conflictSeq: 1,
    localSource: local,
    remoteSource: remote,
    now,
  });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].field, 'name');
  assert.equal(r.merged.location, '现场新位置'); // 只有现场改
  assert.equal(r.merged.maintainUnit, '总库单位'); // 只有总库改
});

test('裁决后写入裁决值并记录裁决人', () => {
  const r0 = mergeEntity({
    kind: 'point',
    server: point({ location: '总库改写' }),
    client: point({ location: '现场改写' }),
    base: point({ location: '路口东侧' }),
    pointCode: 'WZ-2026-001',
    entityName: '测试坡道',
    conflictSeq: 1,
    localSource: local,
    remoteSource: remote,
    now,
  });
  const judge = { supervisorId: 'sup-c', supervisorName: '督导长', clientId: 'dev-c', at: now };
  const { entity, conflict } = resolveConflict(r0.merged, r0.conflicts[0], '最终采用位置', judge, now);
  assert.equal(conflict.status, 'resolved');
  assert.equal(entity.location, '最终采用位置');
  assert.equal(entity.__mods.location.supervisorId, 'sup-c');
});

test('computePendingSet：点位与其子记录的 pending 冲突都会屏蔽该点位', () => {
  const pointById = new Map([
    ['pt-1', { id: 'pt-1', code: 'WZ-2026-001' }],
    ['pt-2', { id: 'pt-2', code: 'WZ-2026-002' }],
  ]);
  const codeById = new Map([
    ['pt-1', 'WZ-2026-001'],
    ['pt-2', 'WZ-2026-002'],
  ]);
  const set = computePendingSet(pointById, codeById, [
    { kind: 'point', entityId: 'pt-1', pointCode: 'WZ-2026-001', status: 'pending' },
    { kind: 'rectify', entityId: 'rct-9', pointCode: 'WZ-2026-002', status: 'pending' },
    { kind: 'point', entityId: 'pt-x', pointCode: 'WZ-2026-009', status: 'resolved' },
  ]);
  assert.deepEqual([...set.pointIds].sort(), ['pt-1', 'pt-2']);
  assert.deepEqual([...set.pointCodes].sort(), ['WZ-2026-001', 'WZ-2026-002']);
});

test('sameValue：对象键顺序不同仍相等', () => {
  assert.equal(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(sameValue([1, 2, 3], [1, 2, 3]), true);
  assert.equal(sameValue({ a: [1, 2] }, { a: [1, 3] }), false);
});
