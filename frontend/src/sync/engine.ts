/**
 * 同步引擎：
 * - 现场改动全部先进本机 outbox（断网可继续核验）；
 * - 网络恢复后一次性把 outbox 全量推给总库，按点位编号做字段级三方合并；
 * - 合并返回的权威快照替换本机业务表，并写影子基线（下次合并的 base）；
 * - 同字段两边都改 → 冲突落本机 conflicts 表，裁决前不进总览/地图；
 * - 裁决也可在断网时暂存，联网后随下一次同步上报。
 */
import { db, META_LAST_SYNC, META_SERVER_REV } from '../db';
import { api, type SyncResponse } from './api';
import { clearOutbox } from './outbox';
import { getIdentity, getClientId } from './identity';
import { toPlain } from '../utils/format';
import type { EntityKind, FieldConflict } from '../types/sync';

const KINDS: EntityKind[] = ['point', 'inspection', 'route', 'rectify'];
const PENDING_RESOLUTIONS_KEY = 'pendingResolutions';

export interface SyncRunResult {
  ok: boolean;
  online: boolean;
  pushed: number;
  conflicts: number;
  rev: number;
  error?: string;
}

interface PendingResolution {
  conflictId: string;
  value: unknown;
}

async function getPendingResolutions(): Promise<PendingResolution[]> {
  const row = await db.syncMeta.get(PENDING_RESOLUTIONS_KEY);
  return row && typeof row.value === 'string' ? (JSON.parse(row.value) as PendingResolution[]) : [];
}

async function setPendingResolutions(list: PendingResolution[]): Promise<void> {
  await db.syncMeta.put({ key: PENDING_RESOLUTIONS_KEY, value: JSON.stringify(list) });
}

/** 把服务端快照落为本机权威数据，并把未推送的本机新建子记录重定向到归并后的点位 id */
async function applySnapshot(resp: SyncResponse): Promise<void> {
  // 服务端 idMap：{ canonicalId: localId }，反转成 localId → canonicalId
  const pointRedirect = new Map<string, string>();
  if (resp.idMap?.point) {
    for (const [canonical, local] of Object.entries(resp.idMap.point)) {
      if (canonical !== local) pointRedirect.set(local, canonical);
    }
  }

  // 子记录里未推送过的本机引用，按点位编号对到总库 id（兼容刚 pull 又断网的情形）
  const codeToId = new Map<string, string>();
  for (const p of resp.entities.point) {
    if (p.code) codeToId.set(p.code, p.id);
  }

  await db.transaction(
    'rw',
    [db.points, db.inspections, db.routes, db.rectifies, db.shadows, db.conflicts, db.syncMeta],
    async () => {
      await db.points.clear();
      await db.inspections.clear();
      await db.routes.clear();
      await db.rectifies.clear();
      await db.shadows.clear();
      await db.conflicts.clear();

      await db.points.bulkPut(resp.entities.point.map(toPlain));
      await db.inspections.bulkPut(resp.entities.inspection.map(toPlain));
      await db.routes.bulkPut(resp.entities.route.map(toPlain));
      await db.rectifies.bulkPut(resp.entities.rectify.map(toPlain));

      // 影子基线 = 刚落库的权威版本
      const shadows: { key: string; kind: string; entityId: string; entity: unknown }[] = [];
      for (const kind of KINDS) {
        for (const e of resp.entities[kind]) {
          shadows.push({ key: `${kind}:${e.id}`, kind, entityId: e.id, entity: toPlain(e) });
        }
      }
      await db.shadows.bulkPut(shadows);
      await db.conflicts.bulkPut(resp.conflicts.map(toPlain));

      await db.syncMeta.put({ key: META_SERVER_REV, value: resp.rev });
      await db.syncMeta.put({ key: META_LAST_SYNC, value: new Date().toISOString() });
    },
  );

  // 未推送的本机新建子记录：快照替换后引用的点位 id 可能已被归并，按编号校正后放回 outbox
  const unsent = await db.outbox.toArray();
  const fixed: typeof unsent = [];
  for (const item of unsent) {
    if (item.kind === 'inspection' || item.kind === 'rectify') {
      const ref = String(item.entity.pointId ?? '');
      const canonical = pointRedirect.get(ref);
      if (canonical) {
        fixed.push({ ...item, entity: { ...item.entity, pointId: canonical } });
        continue;
      }
      // 基线为 null 的新建子记录：按点位编号找到总库 id
      if (!item.base) {
        const localPoint = await db.points.get(ref);
        const mapped = localPoint?.code ? codeToId.get(localPoint.code) : undefined;
        if (mapped && mapped !== ref) {
          fixed.push({ ...item, entity: { ...item.entity, pointId: mapped } });
          continue;
        }
      }
    } else if (item.kind === 'route') {
      const e = item.entity;
      fixed.push({
        ...item,
        entity: {
          ...e,
          fromPointId: pointRedirect.get(String(e.fromPointId)) ?? e.fromPointId,
          toPointId: pointRedirect.get(String(e.toPointId)) ?? e.toPointId,
        },
      });
      continue;
    }
    fixed.push(item);
  }
  if (fixed.some((f, i) => f !== unsent[i])) await db.outbox.bulkPut(fixed.map(toPlain));
}

/**
 * 执行一次同步。返回 online=false 表示断网（改动仍在本机，不报错抛出）。
 */
export async function runSync(): Promise<SyncRunResult> {
  const identity = getIdentity();
  if (!identity) return { ok: false, online: false, pushed: 0, conflicts: 0, rev: 0, error: '未选择督导员身份' };

  const clientId = await getClientId();
  const items = await db.outbox.toArray();
  const pendingResolutions = await getPendingResolutions();

  const entities: Record<string, unknown[]> = { point: [], inspection: [], route: [], rectify: [] };
  const bases: Record<string, unknown> = {};

  // 首次同步（本机尚无总库版本）：把本机全量数据作为基线引导上报，
  // 避免空总库快照清掉历史/示例数据；服务端按 id 与点位编号合并，值相同不产生冲突。
  const revRow = await db.syncMeta.get(META_SERVER_REV);
  const bootstrapping = !revRow;
  if (bootstrapping) {
    const [points, inspections, routes, rectifies] = await Promise.all([
      db.points.toArray(),
      db.inspections.toArray(),
      db.routes.toArray(),
      db.rectifies.toArray(),
    ]);
    entities.point.push(...points.map(toPlain));
    entities.inspection.push(...inspections.map(toPlain));
    entities.route.push(...routes.map(toPlain));
    entities.rectify.push(...rectifies.map(toPlain));
  }

  const outboxKeys = new Set(items.map((i) => `${i.kind}:${i.entityId}`));
  // 引导数据中已在出站队列的实体先剔除，由出站条目（含现场新值）统一提交
  for (const kind of KINDS) {
    entities[kind] = entities[kind].filter((e) => !outboxKeys.has(`${kind}:${(e as { id: string }).id}`));
  }

  for (const item of items) {
    entities[item.kind].push(toPlain(item.entity));
    if (item.base) bases[`${item.kind}:${item.entityId}`] = toPlain(item.base);
  }

  let resp: SyncResponse;
  try {
    resp = await api.sync({
      supervisorId: identity.supervisorId,
      supervisorName: identity.supervisorName,
      clientId,
      entities,
      bases,
      ackResolutions: pendingResolutions,
    });
  } catch (e) {
    // 断网/超时：改动继续留在本机 outbox，现场工作不受影响
    return {
      ok: false,
      online: false,
      pushed: 0,
      conflicts: (await db.conflicts.where('status').equals('pending').count()) as number,
      rev: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  await applySnapshot(resp);
  await clearOutbox();
  // 已随本次请求上报的裁决清空暂存
  await setPendingResolutions([]);

  return {
    ok: true,
    online: true,
    pushed: items.length,
    conflicts: resp.conflicts.filter((c) => c.status === 'pending').length,
    rev: resp.rev,
  };
}

/**
 * 裁决一条冲突。联网时立即同步落定；断网时暂存本机，恢复后随同步上报。
 * 返回时本机冲突表已乐观更新（在线以服务端返回为准，离线标 pending）。
 */
export async function resolveConflictLocal(
  conflict: FieldConflict,
  value: unknown,
): Promise<{ online: boolean }> {
  const identity = getIdentity();
  const clientId = await getClientId();
  const by = identity
    ? {
        supervisorId: identity.supervisorId,
        supervisorName: identity.supervisorName,
        clientId,
        at: new Date().toISOString(),
      }
    : { supervisorId: 'unknown', supervisorName: '未选择身份', clientId, at: new Date().toISOString() };

  // 先尝试在线裁决：走一次完整同步，服务端权威落定
  const pending = await getPendingResolutions();
  if (!pending.some((r) => r.conflictId === conflict.id)) {
    await setPendingResolutions([...pending, { conflictId: conflict.id, value }]);
  }
  const result = await runSync();
  if (result.online) return { online: true };

  // 离线：本机仅记录裁决来源（总览/地图仍保持屏蔽，联网落定后才解除）
  await db.conflicts.put(
    toPlain({ ...conflict, status: 'pending', resolvedValue: value, resolvedBy: by }),
  );
  return { online: false };
}

export { getPendingResolutions };
