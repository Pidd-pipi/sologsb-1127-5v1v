import { db } from '../db';
import { apiGet, apiPost } from '../api/client';
import type {
  PullResponse,
  PushResponse,
  SyncChange,
  SyncEntity,
  UserIdentity,
} from '../types/handover';
import { toPlain } from '../utils/format';

/**
 * 离线同步引擎：
 *  - 断网时改动只写本机 IndexedDB，并用 syncDirty 记录「改动前的值」；
 *  - 网络恢复后把脏数据 + 从未同步过的本地数据（bootstrap）推给服务端，
 *    服务端按点位编号做字段级三路合并；
 *  - 推送成功后全量拉取合并结果回本机，各人得到同一张地图。
 */

const TABLE_OF: Record<SyncEntity, 'points' | 'inspections' | 'rectifies'> = {
  point: 'points',
  inspection: 'inspections',
  rectify: 'rectifies',
};

export async function countDirty(): Promise<number> {
  return db.syncDirty.count();
}

async function pointCodeOf(entity: SyncEntity, data: Record<string, unknown>): Promise<string> {
  if (entity === 'point') return String(data.code ?? '');
  const pointId = String(data.pointId ?? '');
  if (!pointId) return '';
  const point = await db.points.get(pointId);
  return point ? point.code : '';
}

/** 汇总本机待推送改动：脏数据（create/update）+ 从未同步过的本地数据（bootstrap） */
export async function buildChanges(): Promise<SyncChange[]> {
  const changes: SyncChange[] = [];
  const dirtyRows = await db.syncDirty.toArray();
  const dirtyIds = new Set(dirtyRows.map((r) => r.id));
  const baseIds = new Set((await db.syncBase.toArray()).map((r) => r.id));

  for (const row of dirtyRows) {
    const data = (await db[TABLE_OF[row.entity]].get(row.id)) as
      | Record<string, unknown>
      | undefined;
    if (!data) {
      // 本机已不存在的实体（理论上不会发生，防御性清理）
      await db.syncDirty.delete(row.id);
      continue;
    }
    changes.push({
      entity: row.entity,
      op: row.base ? 'update' : 'create',
      id: row.id,
      pointCode: await pointCodeOf(row.entity, data),
      base: row.base,
      data: toPlain(data),
    });
  }

  for (const entity of Object.keys(TABLE_OF) as SyncEntity[]) {
    const rows = (await db[TABLE_OF[entity]].toArray()) as unknown as Record<string, unknown>[];
    for (const row of rows) {
      const id = String(row.id);
      if (dirtyIds.has(id) || baseIds.has(id)) continue;
      changes.push({
        entity,
        op: 'bootstrap',
        id,
        pointCode: await pointCodeOf(entity, row),
        base: null,
        data: toPlain(row),
      });
    }
  }
  return changes;
}

/** 服务端把同编号点位并到既有记录时，本机要换 id 并修正所有引用 */
async function applyRemaps(remapped: PushResponse['remapped']): Promise<void> {
  for (const r of remapped) {
    if (r.entity !== 'point' || r.clientId === r.serverId) continue;
    await db.transaction(
      'rw',
      [db.points, db.inspections, db.rectifies, db.routes, db.syncBase, db.syncDirty],
      async () => {
        const local = await db.points.get(r.clientId);
        if (local) {
          await db.points.delete(r.clientId);
          await db.points.put(toPlain({ ...local, id: r.serverId }));
        }
        await db.inspections.where('pointId').equals(r.clientId).modify({ pointId: r.serverId });
        await db.rectifies.where('pointId').equals(r.clientId).modify({ pointId: r.serverId });
        await db.routes.where('fromPointId').equals(r.clientId).modify({ fromPointId: r.serverId });
        await db.routes.where('toPointId').equals(r.clientId).modify({ toPointId: r.serverId });
        const baseRow = await db.syncBase.get(r.clientId);
        if (baseRow) {
          await db.syncBase.delete(r.clientId);
          await db.syncBase.put({ ...baseRow, id: r.serverId });
        }
        const dirtyRow = await db.syncDirty.get(r.clientId);
        if (dirtyRow) {
          await db.syncDirty.delete(r.clientId);
          await db.syncDirty.put({ ...dirtyRow, id: r.serverId });
        }
      },
    );
  }
}

/** 把服务端合并结果写回本机；同步期间新产生的本机改动保留不动 */
async function applyPull(
  pull: PullResponse,
  pushedIds: Set<string>,
  pushStartedAt: string,
  failedIds: Set<string>,
): Promise<void> {
  const dirtyRows = await db.syncDirty.toArray();
  const stillDirty = new Set(
    dirtyRows.filter((r) => r.changedAt > pushStartedAt || failedIds.has(r.id)).map((r) => r.id),
  );

  const groups: [SyncEntity, Record<string, unknown>[]][] = [
    ['point', pull.points as unknown as Record<string, unknown>[]],
    ['inspection', pull.inspections as unknown as Record<string, unknown>[]],
    ['rectify', pull.rectifies as unknown as Record<string, unknown>[]],
  ];

  await db.transaction('rw', [db.points, db.inspections, db.rectifies, db.syncBase, db.syncDirty], async () => {
    for (const [entity, rows] of groups) {
      const table = db[TABLE_OF[entity]] as unknown as {
        put: (v: Record<string, unknown>) => Promise<unknown>;
      };
      for (const row of rows) {
        const id = String(row.id);
        if (!stillDirty.has(id)) {
          // 干净实体：以服务端为准（含 conflictPending 标记）
          await table.put(toPlain(row));
        }
        await db.syncBase.put({ id, entity, snapshot: toPlain(row) });
      }
    }
    for (const id of pushedIds) {
      if (!stillDirty.has(id)) await db.syncDirty.delete(id);
    }
  });
}

export interface SyncOutcome {
  push: PushResponse;
  pull: PullResponse;
}

/** 执行一轮同步：推送本机改动 → 拉回合并结果。任一环节失败都不清脏标记，可安全重试 */
export async function runSync(user: UserIdentity): Promise<SyncOutcome> {
  const pushStartedAt = new Date().toISOString();
  const changes = await buildChanges();
  const push = await apiPost<PushResponse>('/sync/push', { ...user, changes });
  await applyRemaps(push.remapped || []);
  const pull = await apiGet<PullResponse>('/sync/pull');
  const failedIds = new Set((push.errors || []).map((e) => e.id));
  await applyPull(pull, new Set(changes.map((c) => c.id)), pushStartedAt, failedIds);
  return { push, pull };
}
