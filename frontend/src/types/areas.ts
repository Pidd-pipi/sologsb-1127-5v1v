/**
 * 老城区核验片区名册（前端展示用；权威名册在服务端 /api/meta 返回，
 * 此处仅作离线、未同步前的回退选项）。新增片区以服务端配置为准。
 */
export const AREAS = [
  { code: 'A-DC-01', name: '东一片区（东单—王府井）', district: '东城区' },
  { code: 'A-XC-01', name: '西直门片区', district: '西城区' },
  { code: 'A-CY-01', name: '朝阳公园片区', district: '朝阳区' },
  { code: 'A-HD-01', name: '中关村片区', district: '海淀区' },
  { code: 'A-FT-01', name: '丰台—莲花池片区', district: '丰台区' },
  { code: 'A-SJS-01', name: '鲁谷片区', district: '石景山区' },
] as const;

export function areaName(code?: string): string {
  if (!code) return '';
  return AREAS.find((a) => a.code === code)?.name ?? code;
}
