/**
 * 督导员身份与本机 clientId。
 * - 身份选择保存在 localStorage（换督导员登录时切换）；
 * - clientId 一旦生成即长期保存在 IndexedDB syncMeta，同一台设备不变，
 *   冲突来源据此区分「哪台机器」。
 */
import { db, META_CLIENT_ID } from '../db';
import type { Identity } from '../types/sync';
import { makeId } from '../utils/format';

const IDENTITY_KEY = 'gbaccessmap-identity';

export async function getClientId(): Promise<string> {
  const row = await db.syncMeta.get(META_CLIENT_ID);
  if (row && typeof row.value === 'string') return row.value;
  const clientId = makeId('cli');
  await db.syncMeta.put({ key: META_CLIENT_ID, value: clientId });
  return clientId;
}

export function getIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    return raw ? (JSON.parse(raw) as Identity) : null;
  } catch {
    return null;
  }
}

export function setIdentity(identity: Identity): void {
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
}

export function clearIdentity(): void {
  localStorage.removeItem(IDENTITY_KEY);
}
