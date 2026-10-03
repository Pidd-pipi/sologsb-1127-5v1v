/**
 * 合并引擎：网络恢复后把各督导员本机的点位 / 核验 / 整改改动并进服务端。
 *
 * 合并键：
 *  - 点位按「点位编号 code」合并（不同设备各自生成的内部 id 不一致时以 code 为准）；
 *  - 核验、整改按客户端生成的唯一 id 合并。
 *
 * 字段级三路合并（base = 客户端改动前最后一次见到的服务端值）：
 *  - 仅客户端改过（server === base）→ 采用客户端值；
 *  - 仅服务端改过（client === base）→ 保留服务端值；
 *  - 两边都改成同一个值 → 无需处理；
 *  - 两边都改过且不一致 → 生成冲突记录，两份值都保留并标出来源，
 *    对应点位标记 conflictPending，裁决前不进总览和地图。
 */

export const POINT_FIELDS = [
  'code',
  'name',
  'facilityType',
  'lng',
  'lat',
  'district',
  'location',
  'builtYear',
  'maintainUnit',
  'regionNo',
];

export const INSPECTION_FIELDS = [
  'pointId',
  'date',
  'inspector',
  'slope',
  'clearWidth',
  'hasHandrail',
  'tactileContinuous',
  'occupied',
  'conclusion',
  'problem',
];

export const RECTIFY_FIELDS = [
  'pointId',
  'requirement',
  'unit',
  'deadline',
  'recheckDate',
  'status',
];

const ENTITY_CONF = {
  point: { table: 'points', fields: POINT_FIELDS },
  inspection: { table: 'inspections', fields: INSPECTION_FIELDS },
  rectify: { table: 'rectifies', fields: RECTIFY_FIELDS },
};

/** 空串与 undefined 视为等同（旧数据没有区域编号时不至于误判冲突） */
function norm(v) {
  return v === undefined || v === '' ? null : v;
}

function eq(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  return JSON.stringify(na) === JSON.stringify(nb);
}

function pick(fields, data) {
  const out = {};
  for (const f of fields) {
    if (data[f] !== undefined) out[f] = data[f];
  }
  return out;
}

function findPointByCode(state, code) {
  return state.points.find((p) => p.code === code);
}

function findPointForEntity(state, entity, data, pointCode) {
  if (pointCode) {
    const byCode = findPointByCode(state, pointCode);
    if (byCode) return byCode;
  }
  if (data && data.pointId) {
    const byId = state.points.find((p) => p.id === data.pointId);
    if (byId) return byId;
  }
  return null;
}

/** 重新计算点位是否仍有未裁决冲突 */
export function refreshConflictFlag(state, point) {
  point.conflictPending = state.conflicts.some(
    (c) => c.status === 'pending' && c.pointCode === point.code,
  );
}

function upsertConflict(state, store, { entity, entityId, point, field, serverValue, localValue, localSource }) {
  const now = new Date().toISOString();
  const existing = state.conflicts.find(
    (c) => c.status === 'pending' && c.entity === entity && c.entityId === entityId && c.field === field,
  );
  const serverSource = (point && point.sourceByField && point.sourceByField[field]) || null;
  if (existing) {
    // 同一字段已有未裁决冲突：刷新双方取值与来源，不重复堆叠
    existing.serverValue = serverValue;
    existing.localValue = localValue;
    existing.localSource = localSource;
    existing.createdAt = now;
    return existing;
  }
  const conflict = {
    id: store.nextId('cf'),
    entity,
    entityId,
    pointCode: point ? point.code : '',
    pointName: point ? point.name : '',
    field,
    serverValue,
    serverSource: serverSource || { userId: 'server', userName: '服务端', at: now },
    localValue,
    localSource,
    status: 'pending',
    resolution: null,
    createdAt: now,
  };
  state.conflicts.push(conflict);
  return conflict;
}

/**
 * 对单个实体做字段级三路合并。
 * 返回 { applied: string[], conflicts: Conflict[] }。
 */
function mergeFields(state, store, entity, existing, base, data, user, point) {
  const { fields } = ENTITY_CONF[entity];
  const applied = [];
  const conflicts = [];
  const safeBase = base && typeof base === 'object' ? base : {};
  const now = new Date().toISOString();

  for (const field of fields) {
    if (data[field] === undefined) continue;
    const clientChanged = !eq(data[field], safeBase[field]);
    if (!clientChanged) continue;
    if (eq(existing[field], safeBase[field])) {
      // 只有客户端改过 → 采用
      existing[field] = data[field];
      applied.push(field);
    } else if (eq(existing[field], data[field])) {
      // 两边改成一样 → 无需处理
    } else {
      // 两边都改过且不一致 → 冲突，两份都保留并标出来源
      const conflict = upsertConflict(state, store, {
        entity,
        entityId: existing.id,
        point,
        field,
        serverValue: existing[field] ?? null,
        localValue: data[field],
        localSource: { userId: user.userId, userName: user.userName, at: now },
      });
      conflicts.push(conflict);
    }
  }

  if (applied.length) {
    existing.updatedAt = now;
    existing.updatedBy = { userId: user.userId, userName: user.userName, at: now };
    existing.sourceByField = existing.sourceByField || {};
    for (const f of applied) {
      existing.sourceByField[f] = { userId: user.userId, userName: user.userName, at: now };
    }
  }
  return { applied, conflicts };
}

function insertEntity(state, entity, data, user) {
  const { table, fields } = ENTITY_CONF[entity];
  const now = new Date().toISOString();
  const row = {
    id: data.id,
    ...pick(fields, data),
    createdAt: data.createdAt || now,
    updatedAt: now,
    updatedBy: { userId: user.userId, userName: user.userName, at: now },
    sourceByField: {},
    conflictPending: false,
  };
  for (const f of fields) {
    if (row[f] !== undefined) {
      row.sourceByField[f] = { userId: user.userId, userName: user.userName, at: now };
    }
  }
  state[table].push(row);
  return row;
}

/**
 * 处理一条客户端改动。
 * change: { entity, op: 'bootstrap'|'create'|'update', id, pointCode, base, data }
 * 返回 { status, conflicts?, remapped? }
 */
export function applyChange(state, store, change, user) {
  const { entity, op } = change;
  const conf = ENTITY_CONF[entity];
  if (!conf) return { status: 'ignored', reason: `未知实体类型 ${entity}` };
  const data = change.data || {};
  const results = { status: 'noop', conflicts: [] };

  if (entity === 'point') {
    const existing = findPointByCode(state, data.code);
    if (op === 'bootstrap') {
      // 初次上传：只补缺，不覆盖、不产生冲突（旧数据照常并进地图）
      if (!existing) {
        insertEntity(state, 'point', data, user);
        results.status = 'created';
      } else {
        results.status = 'kept';
        if (existing.id !== data.id) {
          results.remapped = { entity: 'point', clientId: data.id, serverId: existing.id, code: existing.code };
        }
      }
      return results;
    }
    if (!existing) {
      insertEntity(state, 'point', data, user);
      results.status = 'created';
      return results;
    }
    if (existing.id !== data.id) {
      results.remapped = { entity: 'point', clientId: data.id, serverId: existing.id, code: existing.code };
    }
    // create 撞上已有编号：等价于 base 为空对象的 update，两边都填了的不同字段即冲突
    const base = op === 'create' ? {} : change.base || {};
    const { applied, conflicts } = mergeFields(state, store, 'point', existing, base, data, user, existing);
    if (conflicts.length) {
      existing.conflictPending = true;
      results.conflicts = conflicts;
    }
    results.status = applied.length || conflicts.length ? 'merged' : 'noop';
    return results;
  }

  // inspection / rectify：按客户端唯一 id 合并
  const table = state[conf.table];
  const existing = table.find((row) => row.id === change.id);
  const point = findPointForEntity(state, entity, data, change.pointCode);

  if (op === 'bootstrap') {
    if (!existing) {
      insertEntity(state, entity, data, user);
      results.status = 'created';
    } else {
      results.status = 'kept';
    }
    return results;
  }
  if (!existing) {
    insertEntity(state, entity, data, user);
    results.status = 'created';
    return results;
  }
  const base = op === 'create' ? {} : change.base || {};
  const { applied, conflicts } = mergeFields(state, store, entity, existing, base, data, user, point);
  if (conflicts.length) {
    if (point) point.conflictPending = true;
    results.conflicts = conflicts;
  }
  results.status = applied.length || conflicts.length ? 'merged' : 'noop';
  return results;
}

/** 批量处理一次推送，返回汇总 */
export function applyChanges(state, store, changes, user) {
  const summary = { applied: 0, kept: 0, created: 0, conflicts: [], remapped: [], errors: [] };
  for (const change of changes) {
    try {
      const r = applyChange(state, store, change, user);
      if (r.status === 'created') summary.created += 1;
      if (r.status === 'merged') summary.applied += 1;
      if (r.status === 'kept') summary.kept += 1;
      if (r.conflicts) summary.conflicts.push(...r.conflicts);
      if (r.remapped) summary.remapped.push(r.remapped);
    } catch (err) {
      summary.errors.push({ id: change.id, entity: change.entity, message: err.message });
    }
  }
  return summary;
}
