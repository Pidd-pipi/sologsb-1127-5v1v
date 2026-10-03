/**
 * 老城区核验片区与督导员名册（前后端共享）。
 * 区域编号是下一轮分组进楼的核验单元；旧数据没有 areaCode 时不受影响，照常展示。
 */

export const AREAS = [
  { code: 'A-DC-01', name: '东一片区（东单—王府井）', district: '东城区' },
  { code: 'A-XC-01', name: '西直门片区', district: '西城区' },
  { code: 'A-CY-01', name: '朝阳公园片区', district: '朝阳区' },
  { code: 'A-HD-01', name: '中关村片区', district: '海淀区' },
  { code: 'A-FT-01', name: '丰台—莲花池片区', district: '丰台区' },
  { code: 'A-SJS-01', name: '鲁谷片区', district: '石景山区' },
];

export const SUPERVISORS = [
  { id: 'sup-liwei', name: '督导员 李维' },
  { id: 'sup-wanglan', name: '督导员 王岚' },
  { id: 'sup-chenmo', name: '督导员 陈默' },
];

export function areaName(code) {
  return AREAS.find((a) => a.code === code)?.name ?? code;
}
