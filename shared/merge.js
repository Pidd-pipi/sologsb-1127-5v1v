/**
 * 离线交接的字段级三方合并核心，服务端（Node）与前端（浏览器）共用。
 *
 * 规则（与业务要求逐条对应）：
 * - 按点位编号归并同一实体；
 * - 现场相对「上次同步基线」改过、而总库没改的字段 → 直接采用现场值；
 * - 总库相对基线改过、现场没改的字段 → 保留总库值；
 * - 同一字段两边都改过：值一致则直接落定，值不一致则「两份都保留、
 *   标出来源」，产生 pending 冲突，裁决前该字段不落为单一权威值，
 *   点位也因此不进入总览与地图；
 * - 一边新增的字段（基线里没有）同样按上述规则合并。
 */

export const META_FIELDS = ['id', 'createdAt', 'updatedAt', '__mods'];

/** @typedef {import('./merge.d.ts').AnyEntity} AnyEntity */

/** 深度值相等：原始类型直接比较，数组/对象递归比较（键顺序不敏感） */
export function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameValue(v, b[i]));
  }
  if (typeof a === 'object') {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => sameValue(a[k], b[k]));
  }
  return false;
}

/** 取实体参与字段级合并的字段名（剔除元数据与 __mods 来源表） */
export function userFields(entity) {
  if (!entity) return [];
  return Object.keys(entity).filter((k) => !META_FIELDS.includes(k));
}

/** 实体类型 → 关联点位编号所用字段（点位用自身 code） */
const POINT_REF_FIELDS = { inspection: 'pointId', rectify: 'pointId', route: 'fromPointId' };

/**
 * 计算「未裁决冲突屏蔽集合」：
 * 只要实体（点位本身或其核验/整改/路段子记录）存在 pending 冲突，
 * 该点位及其子记录在裁决前都不进入总览与地图。
 *
 * @param {Map<string, any>} pointById 总库点位 id → 点位
 * @param {Map<string, string>} pointCodeById 点位 id → 点位编号
 * @param {Array<{kind: string, pointCode?: string, entityId: string, status: string}>} conflicts
 * @returns {{pointIds: Set<string>, pointCodes: Set<string>, entityIds: Set<string>}}
 */
export function computePendingSet(pointById, pointCodeById, conflicts) {
  const pointIds = new Set();
  const pointCodes = new Set();
  const entityIds = new Set();
  for (const c of conflicts) {
    if (c.status !== 'pending') continue;
    entityIds.add(c.entityId);
    if (c.kind === 'point') {
      pointIds.add(c.entityId);
      const code = pointById.get(c.entityId)?.code ?? c.pointCode;
      if (code) pointCodes.add(code);
    } else if (c.pointCode) {
      pointCodes.add(c.pointCode);
      for (const [id, p] of pointById) {
        if (p.code === c.pointCode) pointIds.add(id);
      }
    }
  }
  return { pointIds, pointCodes, entityIds };
}

/** 非点位实体按关联字段回溯所属点位 id（已映射后的总库 id） */
export function refPointId(kind, entity) {
  const field = POINT_REF_FIELDS[kind];
  return field ? entity[field] : '';
}


/**
 * 三方字段合并。
 * @param {import('./merge.d.ts').MergeInput} input
 * @returns {import('./merge.d.ts').MergeResult}
 */
export function mergeEntity(input) {
  const { server, client, base, pointCode, entityName, conflictSeq, localSource, remoteSource, now } = input;

  /** 冲突时总库一方的真实来源：取服务端实体 __mods 里记录的改动人，缺失才回退「总库」 */
  const serverMods = (server && server.__mods) || {};
  const remoteSourceFor = (field) => serverMods[field] || remoteSource;

  const fields = new Set([...userFields(server), ...userFields(client), ...userFields(base)]);

  /** @type {Record<string, any>} 合并结果以服务端为底，叠加各字段裁决 */
  const merged = {};
  for (const k of Object.keys(server ?? {})) {
    if (k !== '__mods') merged[k] = server[k];
  }

  /** @type {Record<string, import('./merge.d.ts').FieldMod>} 字段最新来源 */
  const mods = { ...((server && server.__mods) || {}) };
  /** @type {import('./merge.d.ts').FieldConflict[]} */
  const conflicts = [];
  const changedFields = [];

  for (const field of fields) {
    const hasBase = base !== null && Object.prototype.hasOwnProperty.call(base, field);
    const hasServer = server !== null && Object.prototype.hasOwnProperty.call(server, field);
    const hasClient = Object.prototype.hasOwnProperty.call(client, field);
    const baseVal = hasBase ? base[field] : undefined;
    const serverVal = hasServer ? server[field] : undefined;
    const clientVal = hasClient ? client[field] : undefined;

    const serverChanged = hasServer && (!hasBase || !sameValue(serverVal, baseVal));
    const clientChanged = hasClient && (!hasBase || !sameValue(clientVal, baseVal));

    if (!serverChanged && !clientChanged) {
      if (hasServer) merged[field] = serverVal;
      else if (hasClient) merged[field] = clientVal;
      continue;
    }

    changedFields.push(field);

    if (serverChanged && clientChanged) {
      // 同一字段两边都改过：值一致 → 直接落定；不一致 → 双留、标来源、待裁决
      if (sameValue(serverVal, clientVal)) {
        merged[field] = clientVal;
        mods[field] = localSource;
      } else {
        merged[field] = serverVal; // 冲突未裁决前先沿用总库原值，不进入权威统计
        mods[field] = remoteSource;
        conflicts.push({
          id: `cfl-${client.id}-${field}-${conflictSeq}`,
          kind: input.kind,
          pointCode,
          entityId: client.id,
          entityName,
          field,
          localValue: clientVal,
          localSource,
          remoteValue: serverVal,
          remoteSource: remoteSourceFor(field),
          status: 'pending',
          createdAt: now,
        });
      }
    } else if (clientChanged) {
      merged[field] = clientVal;
      mods[field] = localSource;
    } else {
      merged[field] = serverVal;
      mods[field] = remoteSource;
    }
  }

  // 元数据：创建时间取最早，更新时间取最新（任一方缺失时用另一边补齐）
  merged.id = client.id;
  merged.createdAt =
    (server && server.createdAt) || base?.createdAt || client.createdAt || now;
  merged.updatedAt = now;
  merged.__mods = mods;

  return { merged, conflicts, changedFields };
}

/**
 * 裁决一条字段冲突：把裁决值写入实体并记录裁决人。
 */
export function resolveConflict(entity, conflict, value, by, now) {
  const next = { ...entity, [conflict.field]: value, updatedAt: now };
  const mods = { ...((entity && entity.__mods) || {}) };
  mods[conflict.field] = by;
  next.__mods = mods;
  return {
    entity: next,
    conflict: {
      ...conflict,
      status: 'resolved',
      resolvedValue: value,
      resolvedBy: by,
      resolvedAt: now,
    },
  };
}
