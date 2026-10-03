/** 冲突裁决列表用的字段中文名（未列出的字段回退原文） */
const FIELD_LABELS: Record<string, string> = {
  code: '点位编号',
  name: '名称',
  facilityType: '设施类型',
  lng: '经度',
  lat: '纬度',
  district: '行政区',
  location: '所在道路或建筑',
  builtYear: '建成年代',
  maintainUnit: '养护单位',
  areaCode: '核验片区',
  date: '日期',
  inspector: '核验人',
  slope: '坡度',
  clearWidth: '净宽',
  hasHandrail: '扶手',
  tactileContinuous: '盲道连续性',
  occupied: '占用情况',
  conclusion: '结论',
  problem: '问题描述',
  requirement: '整改要求',
  unit: '责任单位',
  deadline: '整改期限',
  recheckDate: '复检日期',
  status: '状态',
  routeName: '路线名称',
  fromPointId: '起点点位',
  toPointId: '终点点位',
  length: '长度',
  obstacleCount: '障碍数',
  stepCount: '台阶数',
  curbHeight: '路缘高差',
  wheelchairPassable: '轮椅可通行',
  order: '顺序',
};

const KIND_LABELS: Record<string, string> = {
  point: '点位',
  inspection: '核验记录',
  route: '路段',
  rectify: '整改条目',
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** 冲突值展示：布尔/空值转中文，其余转字符串 */
export function formatConflictValue(value: unknown): string {
  if (value === '' || value === null || value === undefined) return '（空）';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
