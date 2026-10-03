/**
 * 同步服务 API 客户端。
 * 基址取 VITE_SYNC_BASE；开发环境 vite 代理到 http://localhost:21828，
 * docker 同源部署时也走 /api，所以默认 '/api'。
 */
import type { FieldConflict, SyncSnapshot, SnapshotEntities } from '../types/sync';
import type { AreaStateView } from '../types/sync';

export const API_BASE = (import.meta.env.VITE_SYNC_BASE || '/api').replace(/\/$/, '');

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) throw new ApiError(res.status, body.error || `HTTP ${res.status}`);
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface MetaResponse {
  areas: { code: string; name: string; district: string }[];
  supervisors: { id: string; name: string }[];
  serverTime: number;
}

export interface ClaimResponse {
  status: 'holder' | 'queued';
  queuePosition: number;
  view: AreaStateView;
}

export interface SyncRequest {
  supervisorId: string;
  supervisorName: string;
  clientId: string;
  entities: Record<string, unknown[]>;
  bases: Record<string, unknown>;
  ackResolutions: { conflictId: string; value: unknown }[];
}

export interface SyncResponse extends SyncSnapshot {
  idMap: Record<string, Record<string, string>> | null;
  syncedBy: { supervisorId: string; supervisorName: string; clientId: string } | null;
  claims: Record<string, AreaStateView>;
  areas: MetaResponse['areas'];
  supervisors: MetaResponse['supervisors'];
}

export const api = {
  meta: () => request<MetaResponse>('/meta'),
  areas: () => request<{ areas: Record<string, AreaStateView> }>('/areas', undefined, 5000),
  claim: (body: { areaCode: string; supervisorId: string; supervisorName: string; clientId: string }) =>
    request<ClaimResponse>('/areas/claim', { method: 'POST', body: JSON.stringify(body) }),
  release: (body: { areaCode: string; supervisorId: string }) =>
    request<{ view: AreaStateView }>('/areas/release', { method: 'POST', body: JSON.stringify(body) }),
  heartbeat: (body: { areaCode: string; supervisorId: string; supervisorName: string; clientId: string }) =>
    request<{ view: AreaStateView }>('/areas/heartbeat', { method: 'POST', body: JSON.stringify(body) }),
  sync: (body: SyncRequest, timeoutMs = 15000) =>
    request<SyncResponse>('/sync', { method: 'POST', body: JSON.stringify(body) }, timeoutMs),
};

export type { SyncSnapshot, SnapshotEntities, FieldConflict };
