import type { AccessPoint } from './point';
import type { Inspection } from './inspection';
import type { RectifyPlan } from './rectify';

/** 督导员身份（本机选择，随请求上报） */
export interface UserIdentity {
  userId: string;
  userName: string;
}

export interface RegionHolder extends UserIdentity {
  claimedAt: string;
}

export interface RegionQueueEntry extends UserIdentity {
  queuedAt: string;
}

/** 认领区域：同一时刻仅一名接管人，其余排队 */
export interface Region {
  regionNo: string;
  name: string;
  holder: RegionHolder | null;
  queue: RegionQueueEntry[];
}

export type ClaimResult =
  | { result: 'claimed'; region: Region }
  | { result: 'queued'; position: number; holder: RegionHolder; region: Region };

export type ConflictEntity = 'point' | 'inspection' | 'rectify';

export interface ConflictSource extends UserIdentity {
  at?: string;
}

/** 字段级冲突：同一字段两边都改过，两份值都保留并标出来源 */
export interface ConflictRecord {
  id: string;
  entity: ConflictEntity;
  entityId: string;
  pointCode: string;
  pointName: string;
  field: string;
  serverValue: unknown;
  serverSource: ConflictSource;
  localValue: unknown;
  localSource: ConflictSource;
  status: 'pending' | 'resolved';
  resolution: {
    choice: 'server' | 'local';
    appliedValue: unknown;
    resolvedBy: ConflictSource;
    resolvedAt: string;
  } | null;
  createdAt: string;
}

export type SyncEntity = 'point' | 'inspection' | 'rectify';
export type SyncOp = 'bootstrap' | 'create' | 'update';

/** 一条待推送改动：base 为本机改动前最后一次见到的服务端值（三路合并用） */
export interface SyncChange {
  entity: SyncEntity;
  op: SyncOp;
  id: string;
  pointCode: string;
  base: Record<string, unknown> | null;
  data: Record<string, unknown>;
}

export interface RemapEntry {
  entity: SyncEntity;
  clientId: string;
  serverId: string;
  code: string;
}

export interface PushResponse {
  applied: number;
  kept: number;
  created: number;
  conflicts: ConflictRecord[];
  remapped: RemapEntry[];
  errors: { id: string; entity: string; message: string }[];
  serverTime: string;
}

export interface PullResponse {
  points: AccessPoint[];
  inspections: Inspection[];
  rectifies: RectifyPlan[];
  regions: Region[];
  conflicts: ConflictRecord[];
  serverTime: string;
}

/** 字段中文名（冲突裁决展示用） */
export const FIELD_LABELS: Record<string, string> = {
  code: '点位编号',
  name: '名称',
  facilityType: '设施类型',
  lng: '经度',
  lat: '纬度',
  district: '行政区',
  location: '所在道路或建筑',
  builtYear: '建成年代',
  maintainUnit: '养护单位',
  regionNo: '区域编号',
  pointId: '所属点位',
  date: '核验日期',
  inspector: '核验人',
  slope: '坡度%',
  clearWidth: '净宽cm',
  hasHandrail: '扶手',
  tactileContinuous: '盲道连续',
  occupied: '占用情况',
  conclusion: '结论',
  problem: '问题描述',
  requirement: '整改要求',
  unit: '责任单位',
  deadline: '整改期限',
  recheckDate: '复检日期',
  status: '状态',
};

export const ENTITY_LABELS: Record<ConflictEntity, string> = {
  point: '点位',
  inspection: '核验',
  rectify: '整改',
};

/** 冲突值展示：布尔与空值人性化 */
export function formatConflictValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '（空）';
  if (v === true) return '有';
  if (v === false) return '无';
  return String(v);
}
