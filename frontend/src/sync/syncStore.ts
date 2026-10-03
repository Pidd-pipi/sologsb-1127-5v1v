/**
 * 交接状态 store：当前身份、网络/同步阶段、各片区接管人与队列、
 * 待出站改动数、待裁决冲突数。App 启动后自动轮询与定时心跳。
 */
import { create } from 'zustand';
import { api } from './api';
import { runSync } from './engine';
import { db } from '../db';
import { getIdentity, setIdentity as persistIdentity, getClientId } from './identity';
import type { AreaStateView, Identity, SyncPhase } from '../types/sync';

interface SyncState {
  identity: Identity | null;
  clientId: string;
  phase: SyncPhase;
  lastSyncAt: string;
  serverRev: number;
  online: boolean;
  outboxCount: number;
  pendingConflictCount: number;
  areas: Record<string, AreaStateView>;
  /** 当前身份在某片区的领取结果（接管/排队/位置），key=areaCode */
  myClaims: Record<string, { status: 'holder' | 'queued'; queuePosition: number }>;
  meta: { areas: { code: string; name: string; district: string }[]; supervisors: { id: string; name: string }[] };
  lastError: string;
  /** init 幂等守卫，避免页面重复挂载时叠加多个轮询/心跳定时器 */
  started: boolean;

  init: () => Promise<void>;
  selectIdentity: (supervisorId: string, supervisorName: string) => Promise<void>;
  refreshCounts: () => Promise<void>;
  claim: (areaCode: string) => Promise<{ status: 'holder' | 'queued'; view: AreaStateView } | null>;
  release: (areaCode: string) => Promise<void>;
  syncNow: () => Promise<{ ok: boolean; online: boolean; pushed: number; conflicts: number; error?: string }>;
  /** 标记冲突表变化（裁决页操作后调用） */
  conflictsChanged: () => Promise<void>;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  identity: getIdentity(),
  clientId: '',
  phase: 'offline',
  lastSyncAt: '',
  serverRev: 0,
  online: false,
  outboxCount: 0,
  pendingConflictCount: 0,
  areas: {},
  myClaims: {},
  meta: { areas: [], supervisors: [] },
  lastError: '',
  started: false,

  init: async () => {
    if (get().started) return;
    set({ started: true });
    const clientId = await getClientId();
    set({ clientId });
    await get().refreshCounts();
    const metaRow = await db.syncMeta.get('lastSyncAt');
    if (metaRow) set({ lastSyncAt: String(metaRow.value) });

    const pollAreas = async () => {
      try {
        const [meta, areasResp] = await Promise.all([api.meta(), api.areas()]);
        const myId = get().identity?.supervisorId;
        set((s) => {
          // 用最新接管/排队实况校正本机记录（如队首已自动接管）
          const myClaims = { ...s.myClaims };
          for (const [areaCode, view] of Object.entries(areasResp.areas)) {
            if (!myClaims[areaCode]) continue;
            const iAmHolder = view.holder?.supervisorId === myId;
            myClaims[areaCode] = iAmHolder
              ? { status: 'holder', queuePosition: 0 }
              : {
                  status: 'queued',
                  queuePosition: view.queue.findIndex((q) => q.supervisorId === myId) + 1,
                };
          }
          return {
            online: true,
            phase: s.phase === 'syncing' ? 'syncing' : 'online',
            meta: { areas: meta.areas, supervisors: meta.supervisors },
            areas: areasResp.areas,
            myClaims,
          };
        });
      } catch {
        set({ online: false, phase: 'offline' });
      }
    };
    await pollAreas();
    setInterval(pollAreas, 15000);

    // 持有/排队片区心跳续期（TTL 5 分钟，App 每 2 分钟一次）
    setInterval(() => {
      const { identity, myClaims } = get();
      if (!identity) return;
      for (const areaCode of Object.keys(myClaims)) {
        void api
          .heartbeat({ areaCode, ...identity, clientId: get().clientId })
          .then((r) => {
            set((s) => ({
              areas: { ...s.areas, [areaCode]: r.view },
              myClaims: {
                ...s.myClaims,
                [areaCode]: {
                  status: r.view.holder?.supervisorId === identity.supervisorId ? 'holder' : 'queued',
                  queuePosition: r.view.queuePosition ?? 0,
                },
              },
            }));
          })
          .catch(() => set({ online: false, phase: 'offline' }));
      }
    }, 2 * 60 * 1000);

    // 联网时自动尝试同步（出站队列有改动或启动时）
    setInterval(() => {
      if (get().online && (get().outboxCount > 0 || !get().lastSyncAt)) void get().syncNow();
    }, 30000);
  },

  selectIdentity: async (supervisorId, supervisorName) => {
    const clientId = await getClientId();
    const identity: Identity = { supervisorId, supervisorName, clientId };
    persistIdentity(identity);
    set({ identity, clientId, myClaims: {} });
  },

  refreshCounts: async () => {
    const [outboxCount, allConflicts, lastRow, revRow] = await Promise.all([
      db.outbox.count(),
      db.conflicts.toArray(),
      db.syncMeta.get('lastSyncAt'),
      db.syncMeta.get('serverRev'),
    ]);
    const pendingConflictCount = allConflicts.filter((c) => c.status === 'pending').length;
    set({
      outboxCount,
      pendingConflictCount,
      lastSyncAt: lastRow ? String(lastRow.value) : '',
      serverRev: revRow ? Number(revRow.value) : 0,
    });
  },

  claim: async (areaCode) => {
    const { identity } = get();
    if (!identity) return null;
    const clientId = await getClientId();
    set({ phase: 'syncing' });
    try {
      const res = await api.claim({ areaCode, ...identity, clientId });
      set((s) => ({
        online: true,
        phase: 'online',
        areas: { ...s.areas, [areaCode]: res.view },
        myClaims: { ...s.myClaims, [areaCode]: { status: res.status, queuePosition: res.view.queuePosition ?? 0 } },
      }));
      return res;
    } catch (e) {
      set({ online: false, phase: 'offline', lastError: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  release: async (areaCode) => {
    const { identity } = get();
    if (!identity) return;
    try {
      const res = await api.release({ areaCode, supervisorId: identity.supervisorId });
      set((s) => {
        const myClaims = { ...s.myClaims };
        delete myClaims[areaCode];
        return {
          online: true,
          phase: 'online',
          areas: { ...s.areas, [areaCode]: res.view },
          myClaims,
        };
      });
      // 释放后拉一下最新队列，其他排队者可能已自动接管
      const areasResp = await api.areas();
      set({ areas: areasResp.areas });
    } catch {
      set({ online: false, phase: 'offline' });
    }
  },

  syncNow: async () => {
    if (!get().identity) return { ok: false, online: false, pushed: 0, conflicts: 0, error: '未选择身份' };
    set({ phase: 'syncing', lastError: '' });
    const result = await runSync();
    set({
      phase: result.online ? 'online' : 'offline',
      online: result.online,
      serverRev: result.rev || get().serverRev,
      lastError: result.error || '',
    });
    await get().refreshCounts();
    if (result.online) {
      try {
        const areasResp = await api.areas();
        set({ areas: areasResp.areas });
      } catch {
        /* 状态接口失败不影响同步结果 */
      }
    }
    return result;
  },

  conflictsChanged: async () => {
    await get().refreshCounts();
  },
}));
