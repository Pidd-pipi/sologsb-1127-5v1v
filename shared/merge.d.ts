/**
 * 离线交接共享类型：服务端（Node）与前端（浏览器）共同引用。
 * 纯数据结构，不依赖任何运行时 API。
 */

/** 参与同步的四类业务实体 */
export type EntityKind = 'point' | 'inspection' | 'route' | 'rectify';

/** 各实体中不参与字段级合并的元数据字段（由系统维护） */
export const META_FIELDS: readonly string[];

export interface PendingSet {
  pointIds: Set<string>;
  pointCodes: Set<string>;
  entityIds: Set<string>;
}

/** 任意业务实体（索引签名，允许挂 __mods 等内部字段） */
export interface AnyEntity {
  id: string;
  [key: string]: unknown;
}

/** 某字段的一次改动来源 */
export interface FieldMod {
  /** 督导员 id */
  supervisorId: string;
  /** 督导员姓名快照 */
  supervisorName: string;
  /** 客户端设备 id */
  clientId: string;
  at: string;
}

/** 字段级冲突（同字段两边都改过 → 保留两份、标注来源、待裁决） */
export interface FieldConflict {
  id: string;
  kind: EntityKind;
  /** 点位编号（便于按点位合并与检索；非点位实体回填其所属点位编号） */
  pointCode: string;
  entityId: string;
  /** 实体展示名（点位名等，冗余存储，裁决列表直接可用） */
  entityName: string;
  field: string;
  /** 现场（本次提交）一方的值 */
  localValue: unknown;
  localSource: FieldMod;
  /** 总库（服务端已有）一方的值 */
  remoteValue: unknown;
  remoteSource: FieldMod;
  status: 'pending' | 'resolved';
  /** 裁决结果值（resolved 后生效） */
  resolvedValue?: unknown;
  resolvedBy?: FieldMod;
  createdAt: string;
  resolvedAt?: string;
}

export interface MergeInput {
  kind: EntityKind;
  /** 服务端当前总库实体（不存在则为 null，表示该实体由现场新建） */
  server: AnyEntity | null;
  /** 现场提交的实体（全量字段） */
  client: AnyEntity;
  /** 现场上一次同步时该实体的基线（新建时为 null） */
  base: AnyEntity | null;
  /** 点位编号：点位实体取 code；其余实体由服务端按关联点位回填 */
  pointCode: string;
  entityName: string;
  /** 冲突 id 去重后缀（同一实体多次冲突时递增） */
  conflictSeq: number;
  localSource: FieldMod;
  remoteSource: FieldMod;
  now: string;
}

export interface MergeResult {
  /** 合并后的总库实体（含 __mods 来源信息），服务端据此持久化 */
  merged: AnyEntity;
  /** 本次合并产生的新冲突（同一字段双方值不一致时一条） */
  conflicts: FieldConflict[];
  /** 实际发生过变化的字段（双方任一方相对基线有改动） */
  changedFields: string[];
}

export function mergeEntity(input: MergeInput): MergeResult;

/** 裁决冲突：把裁决值写入实体对应字段，返回更新后的实体与冲突 */
export function resolveConflict(
  entity: AnyEntity,
  conflict: FieldConflict,
  value: unknown,
  by: FieldMod,
  now: string,
): { entity: AnyEntity; conflict: FieldConflict };

export function computePendingSet(
  pointById: Map<string, AnyEntity>,
  pointCodeById: Map<string, string>,
  conflicts: Pick<FieldConflict, 'kind' | 'pointCode' | 'entityId' | 'status'>[],
): PendingSet;

/** 非点位实体回溯所属点位 id 的关联字段名 */
export function refPointId(kind: Exclude<EntityKind, 'point'>, entity: AnyEntity): string;

/** 深度值相等（用于判定双方改后值是否一致；一致则不产生冲突） */
export function sameValue(a: unknown, b: unknown): boolean;

/** 取实体参与字段级合并的全部字段（剔除元数据） */
export function userFields(entity: AnyEntity | null): string[];
