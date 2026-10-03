import express from 'express';
import { createStore } from './store.js';
import { applyChanges, refreshConflictFlag } from './merge.js';

/**
 * 离线核验交接 API：
 *  - 区域认领：同一区域同一时刻只能一人接管，其余排队并能看到当前接管人；
 *  - 同步合并：按点位编号三路合并，字段级冲突双份留痕；
 *  - 冲突裁决：裁决前对应点位不进总览和地图。
 */
export function createApp(store) {
  const app = express();
  app.use(express.json({ limit: '8mb' }));

  const { state } = store;

  const now = () => new Date().toISOString();

  function requireUser(body) {
    const user = {
      userId: String(body.userId || '').trim(),
      userName: String(body.userName || '').trim(),
    };
    if (!user.userId || !user.userName) {
      const err = new Error('缺少督导员身份（userId / userName）');
      err.status = 400;
      throw err;
    }
    return user;
  }

  // ---------- 健康检查 ----------
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, time: now() });
  });

  // ---------- 区域认领 ----------
  app.get('/api/regions', (req, res) => {
    res.json({ regions: state.regions, serverTime: now() });
  });

  /**
   * 认领区域。状态检查与写占位在同一段同步代码内完成，
   * Node 单线程保证两人并发认领时只有一人拿到 'claimed'。
   */
  app.post('/api/regions/:regionNo/claim', (req, res, next) => {
    try {
      const user = requireUser(req.body || {});
      const region = state.regions.find((r) => r.regionNo === req.params.regionNo);
      if (!region) return res.status(404).json({ error: `区域 ${req.params.regionNo} 不存在` });

      if (!region.holder) {
        region.holder = { ...user, claimedAt: now() };
        store.scheduleSave();
        return res.json({ result: 'claimed', region });
      }
      if (region.holder.userId === user.userId) {
        return res.json({ result: 'claimed', region });
      }
      let position = region.queue.findIndex((q) => q.userId === user.userId);
      if (position === -1) {
        region.queue.push({ ...user, queuedAt: now() });
        position = region.queue.length - 1;
        store.scheduleSave();
      }
      return res.json({
        result: 'queued',
        position: position + 1,
        holder: region.holder,
        region,
      });
    } catch (err) {
      return next(err);
    }
  });

  /** 释放区域：仅当前接管人可操作，队首自动成为新接管人 */
  app.post('/api/regions/:regionNo/release', (req, res, next) => {
    try {
      const user = requireUser(req.body || {});
      const region = state.regions.find((r) => r.regionNo === req.params.regionNo);
      if (!region) return res.status(404).json({ error: `区域 ${req.params.regionNo} 不存在` });
      if (!region.holder || region.holder.userId !== user.userId) {
        return res.status(409).json({ error: '只有当前接管人可以释放该区域', region });
      }
      region.holder = null;
      const nextHolder = region.queue.shift();
      if (nextHolder) {
        region.holder = { userId: nextHolder.userId, userName: nextHolder.userName, claimedAt: now() };
      }
      store.scheduleSave();
      return res.json({ result: 'released', region, newHolder: region.holder });
    } catch (err) {
      return next(err);
    }
  });

  /** 退出排队 */
  app.post('/api/regions/:regionNo/leave', (req, res, next) => {
    try {
      const user = requireUser(req.body || {});
      const region = state.regions.find((r) => r.regionNo === req.params.regionNo);
      if (!region) return res.status(404).json({ error: `区域 ${req.params.regionNo} 不存在` });
      const before = region.queue.length;
      region.queue = region.queue.filter((q) => q.userId !== user.userId);
      if (region.queue.length !== before) store.scheduleSave();
      return res.json({ result: 'left', region });
    } catch (err) {
      return next(err);
    }
  });

  // ---------- 同步合并 ----------
  app.post('/api/sync/push', (req, res, next) => {
    try {
      const user = requireUser(req.body || {});
      const changes = Array.isArray(req.body.changes) ? req.body.changes : [];
      const summary = applyChanges(state, store, changes, user);
      store.scheduleSave();
      return res.json({ ...summary, serverTime: now() });
    } catch (err) {
      return next(err);
    }
  });

  /** 全量拉取：各人回到有网环境后拿到同一份合并结果 */
  app.get('/api/sync/pull', (req, res) => {
    res.json({
      points: state.points,
      inspections: state.inspections,
      rectifies: state.rectifies,
      regions: state.regions,
      conflicts: state.conflicts,
      serverTime: now(),
    });
  });

  // ---------- 冲突裁决 ----------
  app.get('/api/conflicts', (req, res) => {
    const status = req.query.status;
    const list = status ? state.conflicts.filter((c) => c.status === status) : state.conflicts;
    res.json({ conflicts: list, serverTime: now() });
  });

  /**
   * 裁决：choice = 'server' 保留服务端值；choice = 'local' 采用上报值。
   * 裁决后若点位没有其他未裁决冲突，自动解除 conflictPending，重新进入总览和地图。
   */
  app.post('/api/conflicts/:id/resolve', (req, res, next) => {
    try {
      const user = requireUser(req.body || {});
      const choice = req.body.choice === 'local' ? 'local' : 'server';
      const conflict = state.conflicts.find((c) => c.id === req.params.id);
      if (!conflict) return res.status(404).json({ error: `冲突 ${req.params.id} 不存在` });
      if (conflict.status !== 'pending') {
        return res.status(409).json({ error: '该冲突已裁决', conflict });
      }

      const table = { point: state.points, inspection: state.inspections, rectify: state.rectifies }[
        conflict.entity
      ];
      const entity = table.find((row) => row.id === conflict.entityId);
      const appliedValue = choice === 'local' ? conflict.localValue : conflict.serverValue;
      if (entity && choice === 'local') {
        entity[conflict.field] = conflict.localValue;
        entity.updatedAt = now();
        entity.updatedBy = { ...user, at: now() };
        entity.sourceByField = entity.sourceByField || {};
        entity.sourceByField[conflict.field] = { ...user, at: now() };
      }

      conflict.status = 'resolved';
      conflict.resolution = {
        choice,
        appliedValue,
        resolvedBy: { ...user, at: now() },
        resolvedAt: now(),
      };

      const point = state.points.find((p) => p.code === conflict.pointCode);
      if (point) refreshConflictFlag(state, point);
      store.scheduleSave();
      return res.json({ conflict, point });
    } catch (err) {
      return next(err);
    }
  });

  // ---------- 总览（未裁决冲突点位不进入统计） ----------
  app.get('/api/overview', (req, res) => {
    const visible = state.points.filter((p) => !p.conflictPending);
    const visibleIds = new Set(visible.map((p) => p.id));
    const inspections = state.inspections.filter((i) => visibleIds.has(i.pointId));
    const rectifies = state.rectifies.filter((r) => visibleIds.has(r.pointId));

    const latestByPoint = new Map();
    for (const insp of inspections) {
      const cur = latestByPoint.get(insp.pointId);
      if (!cur || cur.date < insp.date) latestByPoint.set(insp.pointId, insp);
    }
    const group = (keyOf) => {
      const map = new Map();
      for (const p of visible) {
        const key = keyOf(p) || '未分区';
        const g = map.get(key) || { key, total: 0, pass: 0, pending: 0 };
        g.total += 1;
        if (latestByPoint.get(p.id)?.conclusion === '合格') g.pass += 1;
        g.pending += rectifies.filter((r) => r.pointId === p.id && r.status !== '已整改').length;
        map.set(key, g);
      }
      return [...map.values()].map((g) => ({
        ...g,
        passRate: g.total ? Math.round((g.pass / g.total) * 1000) / 10 : 0,
      }));
    };

    res.json({
      totalPoints: visible.length,
      hiddenByConflict: state.points.length - visible.length,
      pendingConflicts: state.conflicts.filter((c) => c.status === 'pending').length,
      inspections: inspections.length,
      pendingRectifies: rectifies.filter((r) => r.status !== '已整改').length,
      byDistrict: group((p) => p.district),
      byFacilityType: group((p) => p.facilityType),
      serverTime: now(),
    });
  });

  // 统一错误处理
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error('[api]', err);
    res.status(status).json({ error: err.message || '服务器内部错误' });
  });

  return app;
}
