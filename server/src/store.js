import fs from 'node:fs';
import path from 'node:path';

/**
 * 服务端状态存储：内存对象 + JSON 文件写穿持久化（临时文件 + rename 保证原子写）。
 * Node 单线程模型下，所有状态变更函数都是同步执行的，天然满足
 * 「两人并发认领同一区域只能一人成功」的原子性要求。
 */

export const DEFAULT_REGIONS = [
  { regionNo: 'LC-01', name: '东门片区' },
  { regionNo: 'LC-02', name: '西门片区' },
  { regionNo: 'LC-03', name: '南门片区' },
  { regionNo: 'LC-04', name: '北门片区' },
];

export function emptyState() {
  return {
    points: [],
    inspections: [],
    rectifies: [],
    conflicts: [],
    regions: DEFAULT_REGIONS.map((r) => ({ ...r, holder: null, queue: [] })),
    seq: 1,
  };
}

export function createStore(dataFile) {
  let state = emptyState();
  let saveTimer = null;

  function load() {
    try {
      if (dataFile && fs.existsSync(dataFile)) {
        const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        state = { ...emptyState(), ...raw };
        // 兼容早期文件：区域可能缺 queue/holder 字段
        for (const region of state.regions) {
          region.holder = region.holder ?? null;
          region.queue = Array.isArray(region.queue) ? region.queue : [];
        }
      }
    } catch (err) {
      console.error(`[store] 读取 ${dataFile} 失败，改用空库：${err.message}`);
      state = emptyState();
    }
  }

  function saveNow() {
    if (!dataFile) return;
    try {
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      const tmp = `${dataFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, dataFile);
    } catch (err) {
      console.error(`[store] 写入 ${dataFile} 失败：${err.message}`);
    }
  }

  /** 变更后调用：防抖落盘，避免一次同步批量写多次 */
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow();
    }, 150);
  }

  function nextId(prefix) {
    const id = `${prefix}-${Date.now().toString(36)}-${state.seq}`;
    state.seq += 1;
    return id;
  }

  load();

  return {
    get state() {
      return state;
    },
    nextId,
    scheduleSave,
    saveNow,
  };
}
