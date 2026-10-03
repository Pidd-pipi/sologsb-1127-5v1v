/**
 * 离线交接（同步层）类型。
 */
import type { AccessPoint } from './point';
import type { Inspection } from './inspection';
import type { RouteSegment } from './route';
import type { RectifyPlan } from './rectify';

export type EntityKind = 'point' | 'inspection' | 'route' | 'rectify';

export interface AnyEntity {
  id: string;
  [key: string]: unknown;
}

/** 字段改动来源（与总库 FieldMod 一致） */
export interface FieldMod {
  supervisorId: string;
  supervisorName: string;
  clientId: string;
  at: string;
}

/** 字段级冲突（同字段两边都改过 → 保留两份、标注来源、待裁决） */
export interface FieldConflict {
  id: string;
  kind: EntityKind;
  /** 点位编号 */
  pointCode: string;
  entityId: string;
  entityName: string;
  field: string;
  localValue: unknown;
  localSource: FieldMod;
  remoteValue: unknown;
  remoteSource: FieldMod;
  status: 'pending' | 'resolved';
  resolvedValue?: unknown;
  resolvedBy?: FieldMod;
  createdAt: string;
  resolvedAt?: string;
}

/** 出站队列条目：现场所有改动先存本机，网络恢复后按此推送 */
export interface OutboxItem {
  /** `${kind}:${id}`，本地同一实体多次改动只留一条（全量推送） */
  key: string;
  kind: EntityKind;
  entityId: string;
  entity: AnyEntity;
  /** 改动时的基线版本（用于总库三方合并） */
  base: AnyEntity | null;
  updatedAt: string;
}

/** 服务端快照实体集合（不带 __mods） */
export interface SnapshotEntities {
  point: AccessPoint[];
  inspection: Inspection[];
  route: RouteSegment[];
  rectify: RectifyPlan[];
}

export interface SyncSnapshot {
  rev: number;
  entities: SnapshotEntities;
  conflicts: FieldConflict[];
}

export interface AreaClaimant {
  supervisorId: string;
  supervisorName: string;
  clientId: string;
}

export interface AreaView extends AreaClaimant {
  expiresAt?: number;
  serverTime?: number;
}

export interface AreaStateView {
  areaCode: string;
  areaName: string;
  holder: AreaView | null;
  queue: AreaClaimant[];
  queuePosition?: number;
}

/** 当前督导员身份（保存在 localStorage） */
export interface Identity extends AreaClaimant {}

export type SyncPhase = 'online' | 'offline' | 'syncing' | 'error';
