/**
 * 区域领取/排队仲裁（纯函数，操作 state.claims）。
 *
 * 业务规则：
 * - 同一区域两个督导员并发领取：只有第一人成为接管人，第二人进入 FIFO 队列，
 *   并能在返回结果里看到接管人是谁；
 * - 接管人释放（或心跳超时）后，队首自动接管；
 * - 排队者可主动退出队列。
 */
import { areaName } from '../shared/areas.js';

const HOLD_TTL_MS = 5 * 60 * 1000;

function nowTtl(now, ttlMs = HOLD_TTL_MS) {
  return now + ttlMs;
}

/** 清理已超时的接管人（其释放后队首自动接管）与排队者 */
function prune(record, now) {
  if (record.holder && record.holder.expiresAt < now) {
    record.holder = null;
  }
  record.queue = record.queue.filter((c) => c.expiresAt >= now);
  if (!record.holder && record.queue.length > 0) {
    record.holder = record.queue.shift();
    record.holder.expiresAt = nowTtl(now);
  }
}

function publicView(record, areaCode, now) {
  if (!record || (!record.holder && record.queue.length === 0)) {
    return { areaCode, areaName: areaName(areaCode), holder: null, queue: [], queuePosition: 0 };
  }
  return {
    areaCode,
    areaName: areaName(areaCode),
    holder: record.holder
      ? {
          supervisorId: record.holder.supervisorId,
          supervisorName: record.holder.supervisorName,
          clientId: record.holder.clientId,
          expiresAt: record.holder.expiresAt,
          serverTime: now,
        }
      : null,
    queue: record.queue.map((c) => ({
      supervisorId: c.supervisorId,
      supervisorName: c.supervisorName,
      clientId: c.clientId,
    })),
  };
}

/**
 * 领取区域。
 * @returns {{status: 'holder'|'queued', view: object}}
 */
export function claim(state, areaCode, claimant, now = Date.now()) {
  let record = state.claims[areaCode];
  if (!record) {
    record = { areaCode, holder: null, queue: [] };
    state.claims[areaCode] = record;
  }
  prune(record, now);

  const person = {
    supervisorId: claimant.supervisorId,
    supervisorName: claimant.supervisorName,
    clientId: claimant.clientId,
    joinedAt: now,
    expiresAt: nowTtl(now),
  };

  // 同一督导员重复领取：已持有则续期，已在队中则刷新心跳，不产生第二个位置
  if (record.holder && record.holder.supervisorId === person.supervisorId) {
    record.holder.expiresAt = person.expiresAt;
    return { status: 'holder', view: publicView(record, areaCode, now) };
  }
  const existedIdx = record.queue.findIndex((c) => c.supervisorId === person.supervisorId);
  if (existedIdx >= 0) {
    record.queue[existedIdx].expiresAt = person.expiresAt;
    return {
      status: 'queued',
      view: { ...publicView(record, areaCode, now), queuePosition: existedIdx + 1 },
    };
  }

  if (!record.holder) {
    record.holder = person;
    return { status: 'holder', view: publicView(record, areaCode, now) };
  }
  record.queue.push(person);
  return {
    status: 'queued',
    view: { ...publicView(record, areaCode, now), queuePosition: record.queue.length },
  };
}

/** 释放接管权（队首自动接管）；排队者调用则退出队列 */
export function release(state, areaCode, supervisorId, now = Date.now()) {
  const record = state.claims[areaCode];
  if (!record) return { ...publicView(record, areaCode, now), queuePosition: 0 };
  prune(record, now);
  if (record.holder && record.holder.supervisorId === supervisorId) {
    record.holder = null;
  } else {
    record.queue = record.queue.filter((c) => c.supervisorId !== supervisorId);
  }
  prune(record, now);
  if (!record.holder && record.queue.length === 0) delete state.claims[areaCode];
  return publicView(state.claims[areaCode] ?? record, areaCode, now);
}

/** 心跳续期：接管人延长 TTL；排队者保活 */
export function heartbeat(state, areaCode, supervisorId, now = Date.now()) {
  const record = state.claims[areaCode];
  if (!record) return publicView(record, areaCode, now);
  prune(record, now);
  if (record.holder?.supervisorId === supervisorId) record.holder.expiresAt = nowTtl(now);
  const q = record.queue.find((c) => c.supervisorId === supervisorId);
  if (q) q.expiresAt = nowTtl(now);
  const view = publicView(record, areaCode, now);
  const pos = record.queue.findIndex((c) => c.supervisorId === supervisorId);
  return { ...view, queuePosition: pos >= 0 ? pos + 1 : 0 };
}

export function areaView(state, areaCode, now = Date.now()) {
  const record = state.claims[areaCode];
  if (record) prune(record, now);
  return publicView(record, areaCode, now);
}

export function allAreaViews(state, now = Date.now()) {
  // 先统一清理过期记录
  for (const code of Object.keys(state.claims)) {
    prune(state.claims[code], now);
    if (!state.claims[code].holder && state.claims[code].queue.length === 0) {
      delete state.claims[code];
    }
  }
  return state.claims;
}
