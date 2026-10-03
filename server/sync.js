/**
 * 同步合并：把各督导员本机改动并入总库。
 * - 按点位编号归并（点位 code 相同即视为同一处点位）；
 * - 字段级三方合并（基线 / 现场 / 总库）；
 * - 同字段两边都改且值不同 → 双留、标来源、待裁决；
 * - 裁决动作单独入口，裁决后才落为权威值。
 */
import { mergeEntity, resolveConflict, refPointId } from '../shared/merge.js';

const KINDS = ['point', 'inspection', 'route', 'rectify'];

export function indexEntities(state) {
  const byId = new Map();
  const pointCodeToId = new Map();
  for (const kind of KINDS) {
    for (const e of state.entities[kind]) {
      byId.set(`${kind}:${e.id}`, e);
      if (kind === 'point' && e.code) pointCodeToId.set(String(e.code), e.id);
    }
  }
  return { byId, pointCodeToId };
}

function stripMeta(entity) {
  const out = {};
  for (const [k, v] of Object.entries(entity)) {
    if (k !== '__mods') out[k] = v;
  }
  return out;
}

/**
 * 处理一次同步提交。直接 mutate state，由调用方负责持久化串行化。
 * @param {import('./types.js').ServerState} state
 * @param {object} body
 */
export function applySync(state, body) {
  const now = new Date().toISOString();
  const localSource = {
    supervisorId: body.supervisorId,
    supervisorName: body.supervisorName || body.supervisorId,
    clientId: body.clientId,
    at: now,
  };
  const remoteSource = {
    supervisorId: 'server',
    supervisorName: '总库',
    clientId: 'server',
    at: now,
  };  /** 现场 id → 总库 id（按点位编号归并时可能重定向） */
  const idMap = { point: {}, inspection: {}, route: {}, rectify: {} };
  const { byId, pointCodeToId } = indexEntities(state);

  const groups = body.entities || {};
  const bases = body.bases || {};

  // 点位先处理，子记录才能按归并结果重定向 pointId
  const orderedKinds = ['point', ...KINDS.filter((k) => k !== 'point')];
  for (const kind of orderedKinds) {
    const list = groups[kind] || [];
    for (const rawClient of list) {
      const client = stripMeta(rawClient);

      if (kind !== 'point') {
        const refField = kind === 'route' ? 'fromPointId' : 'pointId';
        if (client[refField] && idMap.point[client[refField]]) {
          client[refField] = idMap.point[client[refField]];
        }
        // 路段终点同样重定向
        if (kind === 'route' && client.toPointId && idMap.point[client.toPointId]) {
          client.toPointId = idMap.point[client.toPointId];
        }
      }

      // 归并键：先按 id；点位再按编号 code 匹配（两台设备各自登记的同编号点位）
      let server = byId.get(`${kind}:${client.id}`) || null;
      if (!server && kind === 'point' && client.code) {
        const codeId = pointCodeToId.get(String(client.code));
        if (codeId) server = byId.get(`point:${codeId}`);
      }

      let canonicalId = client.id;
      if (server) canonicalId = server.id;
      if (canonicalId !== client.id) {
        idMap[kind][canonicalId] = client.id;
        // 归并到已存在的总库实体：把早期挂在旧 id 上的冲突迁到总库 id
        for (const c of Object.values(state.conflicts)) {
          if (c.kind === kind && c.entityId === client.id) c.entityId = canonicalId;
        }
      }

      const baseRaw = bases[`${kind}:${rawClient.id}`] || bases[`${kind}:${canonicalId}`] || null;
      const base = baseRaw ? stripMeta(baseRaw) : null;

      // 非点位实体回溯点位编号，供冲突屏蔽与裁决列表使用
      let pointCode = '';
      let entityName = kind === 'point' ? client.name || client.code || client.id : client.id;
      if (kind === 'point') {
        pointCode = String(client.code ?? '');
      } else {
        const refId = refPointId(kind, client);
        const point = refId && byId.get(`point:${refId}`);
        pointCode = point ? String(point.code ?? '') : '';
        entityName = point ? point.name : entityName;
      }

      const conflictSeq =
        1 +
        Object.values(state.conflicts).filter(
          (c) => c.kind === kind && c.entityId === canonicalId && c.status === 'pending',
        ).length;

      const result = mergeEntity({
        kind,
        server,
        client: { ...client, id: canonicalId },
        base,
        pointCode,
        entityName,
        conflictSeq,
        localSource,
        remoteSource,
        now,
      });

      // 落库：有则替换，无则新增
      const arr = state.entities[kind];
      const idx = arr.findIndex((e) => e.id === canonicalId);
      if (idx >= 0) arr[idx] = result.merged;
      else arr.push(result.merged);
      byId.set(`${kind}:${canonicalId}`, result.merged);
      if (kind === 'point' && result.merged.code) {
        pointCodeToId.set(String(result.merged.code), canonicalId);
      }

      for (const c of result.conflicts) {
        state.conflicts[c.id] = c;
      }
    }
  }

  // 裁决动作：ackResolutions 携带 { conflictId, value }
  for (const r of body.ackResolutions || []) {
    const conflict = state.conflicts[r.conflictId];
    if (!conflict || conflict.status !== 'pending') continue;
    const entity = byId.get(`${conflict.kind}:${conflict.entityId}`);
    if (!entity) continue;
    const out = resolveConflict(entity, conflict, r.value, localSource, now);
    const arr = state.entities[conflict.kind];
    const idx = arr.findIndex((e) => e.id === conflict.entityId);
    if (idx >= 0) arr[idx] = out.entity;
    state.conflicts[r.conflictId] = out.conflict;
  }

  return snapshot(state, { idMap, localSource });
}

/** 去掉 __mods 的对外实体（__mods 仅服务端内部用于来源追踪） */
function publicEntity(e) {
  return stripMeta(e);
}

export function snapshot(state, extra = {}) {
  return {
    rev: state.rev,
    entities: {
      point: state.entities.point.map(publicEntity),
      inspection: state.entities.inspection.map(publicEntity),
      route: state.entities.route.map(publicEntity),
      rectify: state.entities.rectify.map(publicEntity),
    },
    conflicts: Object.values(state.conflicts),
    idMap: extra.idMap || null,
    syncedBy: extra.localSource || null,
  };
}
