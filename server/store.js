/**
 * 服务端总库状态 + JSON 文件持久化（原子写）。
 * 容器无状态时数据落在 ./data/state.json；清空文件即重置演示。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** @returns {import('./types.js').ServerState} */
export function emptyState() {
  return {
    rev: 0,
    /** @type {Record<string, import('./types.js').AnyEntity[]>} */
    entities: { point: [], inspection: [], route: [], rectify: [] },
    /** @type {Record<string, import('./types.js').FieldConflict>} */
    conflicts: {},
    /** @type {Record<string, import('./types.js').ClaimRecord>} key: areaCode */
    claims: {},
  };
}

export class JsonStore {
  /**
   * @param {string} filePath
   */
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {import('./types.js').ServerState} */
    this.state = emptyState();
    this.chain = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = { ...emptyState(), ...parsed };
      this.state.entities = { ...emptyState().entities, ...(parsed.entities || {}) };
      this.state.conflicts = parsed.conflicts || {};
      this.state.claims = parsed.claims || {};
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.state = emptyState();
    }
  }

  /** 串行化所有写操作，避免并发请求交叉写文件 */
  mutate(fn) {
    this.chain = this.chain.then(async () => {
      await fn(this.state);
      this.state.rev += 1;
      await this.persist();
    });
    return this.chain;
  }

  async persist() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state), 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}
