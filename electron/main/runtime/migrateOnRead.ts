/**
 * 读时 schema 迁移执行器（D5）——统一的「文件头版本号 + 迁移函数链」约定的最小内核。
 *
 * schema 必演进。读时迁移把成本从「每次发版写一次性脚本 + 担心漏迁」降到「加一个迁移函数、永久保留」：
 * 老数据打开即在内存升级到最新形态，写盘时带最新 version；新数据零开销（链 0 次执行）。
 *
 * 克制：这只是一个**纯执行器**，不是框架。各持久化模块**自己持有自己的 chain**（与该模块读盘代码
 * 同处可见、可独立审计），不建中央 registry——彼此无关的 schema 演进不该耦进一处。统一的只有
 * 「版本号 + 函数链」这个约定和这个执行器。设计见 docs/tech/2026-06-24-d5-read-time-migration-design.md。
 */

/** chain[k] = 从版本 (baselineVersion + k) 升到 (baselineVersion + k + 1) 的纯转换。 */
export type Migration = (prev: unknown) => unknown;

/**
 * 磁盘数据结构性损坏（version 字段非法）。独立类型让 adopter 能把它与「文件不存在 / JSON 半写坏」
 * 区分对待：后者可静默降级为空，前者必须 fail-loud——静默清空会被下一次写盘物理覆盖、不可逆丢数据。
 */
export class SchemaMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaMigrationError';
    // 转译 target 下 `extends Error` 会断原型链致 instanceof 失效——显式修回，adopter 靠它分流。
    Object.setPrototypeOf(this, SchemaMigrationError.prototype);
  }
}

/**
 * 磁盘数据版本高于本程序支持（旧程序读到新格式）——不是损坏，是「降级安装」异常路径。
 * migrateOnRead 对 version>current 原样返回（是否前向兼容读由 adopter 定），但 adopter 若无法按新
 * 格式安全处理，正确动作是抛此错「如实拒绝」（data-durability §Ver）：绝不按旧结构改写、让版本号倒退。
 */
export class FutureSchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FutureSchemaVersionError';
    Object.setPrototypeOf(this, FutureSchemaVersionError.prototype);
  }
}

/**
 * 把任意版本的磁盘数据升级到最新形态。
 *
 * @param raw          JSON.parse 后的原始数据。无 `version` 字段 = 「框架引入前的老文件」。
 * @param chain        迁移函数链；`currentVersion = baselineVersion + chain.length`（派生，不作冗余入参）。
 * @param baselineVersion 该 store 最早格式号；无 version 字段的老文件视作此版本（不硬编码 1，防把已是
 *                        中间态的老文件当 v1 再跑一遍 chain[0] 的双重迁移）。
 */
export function migrateOnRead<T>(
  raw: unknown,
  chain: ReadonlyArray<Migration>,
  baselineVersion: number,
): T {
  const currentVersion = baselineVersion + chain.length;
  const rawVersion = (raw as { version?: unknown } | null)?.version;
  if (
    rawVersion !== undefined &&
    (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion) || rawVersion < baselineVersion)
  ) {
    // 字符串 "2" / 小数 / 低于 baseline（含负数）的 version = 磁盘数据破损：显式抛比静默当「无 version」
    // 全链重跑、或拿负数索引 chain 崩出无意义 TypeError 都安全得多。version > current 不在此列（见下，不降级）。
    throw new SchemaMigrationError(
      `migrateOnRead: version 字段非法（期望 ≥ baseline 的整数），实际 ${JSON.stringify(rawVersion)}`,
    );
  }
  let v = typeof rawVersion === 'number' ? rawVersion : baselineVersion;
  let data: unknown = raw;
  // chain[v - baselineVersion]：把 v 升到 v+1。version > current 时 while 不执行，原样返回（不降级）。
  while (v < currentVersion) {
    data = chain[v - baselineVersion](data);
    v++;
  }
  return data as T;
}
