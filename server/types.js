/**
 * 服务端 JSDoc 类型别名，真正的结构定义见 shared/merge.d.ts。
 * @typedef {import('../shared/merge.d.ts').AnyEntity} AnyEntity
 * @typedef {import('../shared/merge.d.ts').EntityKind} EntityKind
 * @typedef {import('../shared/merge.d.ts').FieldConflict} FieldConflict
 * @typedef {import('../shared/merge.d.ts').FieldMod} FieldMod
 *
 * @typedef {Object} Claimant
 * @property {string} supervisorId
 * @property {string} supervisorName
 * @property {string} clientId
 * @property {number} joinedAt  排队时间（epoch ms），FIFO 依据
 * @property {number} expiresAt 持有/排队过期时间（epoch ms）
 *
 * @typedef {Object} ClaimRecord
 * @property {string} areaCode
 * @property {Claimant} holder
 * @property {Claimant[]} queue
 *
 * @typedef {Object} ServerState
 * @property {number} rev
 * @property {Record<EntityKind, AnyEntity[]>} entities
 * @property {Record<string, FieldConflict>} conflicts
 * @property {Record<string, ClaimRecord>} claims
 */
export {};
