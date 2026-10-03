/**
 * 出站队列：现场一切改动先存本机 IndexedDB，断网也不丢；
 * 网络恢复后由 syncEngine 统一推送。同一实体多次本地改动合并成一条（全量推送最新值）。
 */
import { db } from '../db';
import type { AnyEntity, EntityKind } from '../types/sync';
import { toPlain } from '../utils/format';

export function entityKey(kind: EntityKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * 记录一次本地改动。
 * - 首次改动：基线取影子表（上次同步版本），新建实体基线为 null；
 * - 后续改动：沿用队首条目保存的基线（基线永远是「上一次同步」的版本，不是上一次保存）。
 */
export async function enqueueChange<T extends { id: string }>(kind: EntityKind, entity: T): Promise<void> {
  const key = entityKey(kind, entity.id);
  const now = new Date().toISOString();
  const existing = await db.outbox.get(key);
  if (existing) {
    await db.outbox.put({ ...existing, entity: toPlain(entity) as unknown as AnyEntity, updatedAt: now });
    return;
  }
  const shadow = await db.shadows.get(key);
  await db.outbox.put({
    key,
    kind,
    entityId: entity.id,
    entity: toPlain(entity) as unknown as AnyEntity,
    base: shadow ? (toPlain(shadow.entity) as AnyEntity) : null,
    updatedAt: now,
  });
}

/** 推送成功后清队列（全量出站模型：本次推送已含所有待同步改动） */
export async function clearOutbox(): Promise<void> {
  await db.outbox.clear();
}

export async function pendingCount(): Promise<number> {
  return db.outbox.count();
}
