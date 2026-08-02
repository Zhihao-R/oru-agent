/**
 * 带格式版本封套的记录编解码器（S06 范式的共享原语）。
 *
 * 「{version, <字段>} 封套 + 读时迁移 + 迁移前原样副本 + 未来版本跳过」这套 S06 落盘约定，此前在
 * tasks/store、bg-commands/store 各手抄一份（版本号常量 + serialize + readXFile 逐字同构）。收成这里。
 *
 * 只共享封套原语——各存储的业务字段、hydrate 补默认、目录/sidecar/流文件仍各留（那些是业务差异，
 * 不是重复）。封套字段名（'task' / 'record'…）是历史落盘格式、按存储注入、不可改。
 */
import { migrateFileOnRead } from './migrateFile';
import type { Migration } from './migrateOnRead';

export type VersionedCodec<T> = {
  /** 当前程序支持的版本 = baseline + chain 长度。 */
  currentVersion: number;
  /** 序列化为 {version, <field>: record} 落盘文本。 */
  serialize: (record: T) => string;
  /** 读一条：迁移到当前版本并取出记录；未来版本 → null（不读不写、绝不让版本倒退）。 */
  read: (path: string, rawText: string) => Promise<Partial<T> | null>;
};

export function makeVersionedCodec<T>(opts: {
  baselineVersion: number;
  chain: readonly Migration[];
  /** 封套里承载记录的字段名（'task' / 'record'…）——历史落盘格式，不可改。 */
  field: string;
  /** 日志前缀（'tasks' / 'bg-commands'…）。 */
  label: string;
}): VersionedCodec<T> {
  const currentVersion = opts.baselineVersion + opts.chain.length;
  return {
    currentVersion,
    serialize: (record) =>
      JSON.stringify({ version: currentVersion, [opts.field]: record }, null, 2),
    read: async (path, rawText) => {
      const env = await migrateFileOnRead<{ version: number } & Record<string, unknown>>(
        path,
        rawText,
        opts.chain,
        opts.baselineVersion,
      );
      if (env.version > currentVersion) {
        console.warn(
          `[${opts.label}] ${path} 格式版本 ${env.version} 高于本程序支持的 ${currentVersion}——跳过`,
        );
        return null;
      }
      return env[opts.field] as Partial<T>;
    },
  };
}
