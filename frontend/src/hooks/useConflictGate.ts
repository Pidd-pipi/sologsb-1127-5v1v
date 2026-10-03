/**
 * 冲突门禁：点位（或其核验/整改/路段子记录）存在 pending 字段冲突时，
 * 该点位在人工裁决前不进入总览统计与地图渲染；裁决后自动恢复。
 * 旧数据没有 areaCode 不受影响，照常展示。
 */
import { useEffect, useMemo, useState } from 'react';
import { db } from '../db';
import type { AccessPoint } from '../types/point';
import type { FieldConflict } from '../types/sync';

export interface ConflictGate {
  /** 因 pending 冲突而被屏蔽的点位 id */
  blockedPointIds: Set<string>;
  /** 被屏蔽点位编号（便于日志/提示） */
  blockedPointCodes: Set<string>;
  pendingConflicts: FieldConflict[];
  ready: boolean;
}

export function useConflictGate(): ConflictGate {
  const [conflicts, setConflicts] = useState<FieldConflict[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const rows = await db.conflicts.toArray();
      if (alive) {
        setConflicts(rows);
        setReady(true);
      }
    };
    void load();
    // 冲突表可能由同步引擎在其他页面写入，轮询保持门禁最新
    const timer = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return useMemo(() => {
    const pending = conflicts.filter((c) => c.status === 'pending');
    return {
      blockedPointIds: new Set(
        pending.filter((c) => c.kind === 'point').map((c) => c.entityId),
      ),
      blockedPointCodes: new Set(pending.map((c) => c.pointCode).filter(Boolean)),
      pendingConflicts: pending,
      ready,
    };
  }, [conflicts, ready]);
}

/** 供只持有点位列表的页面使用：按点位编号 + 点位子记录冲突一并屏蔽 */
export function filterVisiblePoints(points: AccessPoint[], gate: ConflictGate): AccessPoint[] {
  if (gate.blockedPointIds.size === 0 && gate.blockedPointCodes.size === 0) return points;
  return points.filter(
    (p) => !gate.blockedPointIds.has(p.id) && !(p.code && gate.blockedPointCodes.has(p.code)),
  );
}
