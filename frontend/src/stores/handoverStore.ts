import { create } from 'zustand';
import { apiGet, apiPost } from '../api/client';
import { countDirty, runSync } from '../sync/engine';
import type {
  ClaimResult,
  ConflictRecord,
  PullResponse,
  Region,
  UserIdentity,
} from '../types/handover';

/** 队里的督导员（本机切换身份用，随请求上报给服务端标来源） */
export const SUPERVISORS: UserIdentity[] = [
  { userId: 'u-liwei', userName: '督导员 李维' },
  { userId: 'u-wanglan', userName: '督导员 王岚' },
  { userId: 'u-chenmo', userName: '督导员 陈默' },
  { userId: 'u-zhaomin', userName: '督导员 赵敏' },
];

const USER_KEY = 'gbaccessmap-user';

function loadUser(): UserIdentity {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as UserIdentity;
      if (parsed.userId && parsed.userName) return parsed;
    }
  } catch {
    /* 忽略损坏的本地身份 */
  }
  return SUPERVISORS[0];
}

interface HandoverState {
  user: UserIdentity;
  online: boolean;
  syncing: boolean;
  lastSyncAt: string;
  lastSyncResult: string;
  regions: Region[];
  conflicts: ConflictRecord[];
  dirtyCount: number;
  setUser: (user: UserIdentity) => void;
  setOnline: (online: boolean) => void;
  refreshDirtyCount: () => Promise<void>;
  loadRegions: () => Promise<void>;
  claim: (regionNo: string) => Promise<ClaimResult>;
  release: (regionNo: string) => Promise<void>;
  leaveQueue: (regionNo: string) => Promise<void>;
  loadConflicts: () => Promise<void>;
  resolveConflict: (id: string, choice: 'server' | 'local') => Promise<void>;
  syncNow: () => Promise<void>;
}

export const useHandoverStore = create<HandoverState>((set, get) => ({
  user: loadUser(),
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  syncing: false,
  lastSyncAt: '',
  lastSyncResult: '',
  regions: [],
  conflicts: [],
  dirtyCount: 0,

  setUser: (user) => {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    set({ user });
  },

  setOnline: (online) => set({ online }),

  refreshDirtyCount: async () => {
    try {
      set({ dirtyCount: await countDirty() });
    } catch {
      /* IndexedDB 未就绪时静默 */
    }
  },

  loadRegions: async () => {
    const res = await apiGet<{ regions: Region[] }>('/regions');
    set({ regions: res.regions });
  },

  claim: async (regionNo) => {
    const { user } = get();
    const res = await apiPost<ClaimResult>(`/regions/${regionNo}/claim`, user);
    set((s) => ({
      regions: s.regions.map((r) => (r.regionNo === regionNo ? res.region : r)),
    }));
    return res;
  },

  release: async (regionNo) => {
    const { user } = get();
    const res = await apiPost<{ region: Region }>(`/regions/${regionNo}/release`, user);
    set((s) => ({
      regions: s.regions.map((r) => (r.regionNo === regionNo ? res.region : r)),
    }));
  },

  leaveQueue: async (regionNo) => {
    const { user } = get();
    const res = await apiPost<{ region: Region }>(`/regions/${regionNo}/leave`, user);
    set((s) => ({
      regions: s.regions.map((r) => (r.regionNo === regionNo ? res.region : r)),
    }));
  },

  loadConflicts: async () => {
    const res = await apiGet<{ conflicts: ConflictRecord[] }>('/conflicts');
    set({ conflicts: res.conflicts });
  },

  resolveConflict: async (id, choice) => {
    const { user } = get();
    await apiPost(`/conflicts/${id}/resolve`, { ...user, choice });
    await get().loadConflicts();
  },

  syncNow: async () => {
    const { syncing, online, user } = get();
    if (syncing || !online) return;
    set({ syncing: true });
    try {
      const { push, pull } = await runSync(user);
      set({
        regions: pull.regions,
        conflicts: pull.conflicts,
        lastSyncAt: pull.serverTime,
        lastSyncResult: `已合并：新增 ${push.created} · 更新 ${push.applied} · 冲突 ${push.conflicts.length}`,
      });
      // 合并结果已落本机 IndexedDB，刷新业务 store 让总览 / 地图换成合并后的同一份数据
      const [{ usePointStore }] = await Promise.all([import('../stores/pointStore')]);
      await usePointStore.getState().load();
      await get().refreshDirtyCount();
    } catch (err) {
      set({
        lastSyncResult: `同步失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      set({ syncing: false });
    }
  },
}));

export type { PullResponse };
