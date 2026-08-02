// @vitest-environment node

/** 第 3 期·英译发布门槛：en 与 zh 的 key 集逐 namespace 对齐。
 *
 *  增量 enforcing——en 为 `{}` 的 ns 视为「未翻译」，挂 it.todo 跳过（不 fail）；en 一旦非空，
 *  即强制与 zh **完整双向对齐**：缺键、多余键、空值都 fail。英译随每个 ns 填入逐步转绿，
 *  门槛自动长成完整覆盖——无需另维护一份「已译 ns 清单」（空/非空本身就是开关）。
 *
 *  为什么连「多余键」也禁：zh 是唯一信源；en 里有 zh 没有的键，必是 zh 改键后 en 没跟改的残留。
 *  为什么禁空值：否则用 `"key": ""` 占位就能骗过 key 集对齐，门槛形同虚设。
 *
 *  边界（诚实声明，别给虚假信心）：门槛保证「**已被复数化**的基键两形齐全」，但**无法**保证
 *  「**该复数化**的可数名词确实被复数化了」——译者把 `"foo": "{{count}} items"` 写成裸键时，
 *  对齐与两形检查都过，运行时仍渲染「1 items」。是否传 count 取决于调用点、静态不可判定，
 *  这类只能人工/调用点核。 */
import { describe, it, expect } from 'vitest';
import { resources, ns } from '@shared/i18n/resources';

/** 拍平成「点路径 → 叶子值」；数组展开成下标路径，使中英列表长度不一致也能被对齐检查抓到。 */
function leafEntries(node: unknown, prefix = ''): Array<[string, unknown]> {
  if (Array.isArray(node)) {
    return node.flatMap((v, i) => leafEntries(v, prefix ? `${prefix}.${i}` : String(i)));
  }
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => leafEntries(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, node]];
}
const leafPaths = (node: unknown): string[] => leafEntries(node).map(([k]) => k);

/**
 * i18next 复数后缀。本门槛只管 en↔zh：en 的 CLDR 类别就是 one + other 两类、zh 只有 other 且本仓库
 * zh 用裸键——故只需 one/other（不列 zh 用不到的 two|few|many|zero，也不列 i18next v3 旧式 `_plural`：
 * 本仓库是 v4 风格，留着反会让 `foo_plural` 被「两形齐全」误判）。en 的可数名词需 `_one`/`_other` 两形
 * （否则「1 minutes ago」）；key 集按「剥掉复数后缀的基键」比对：zh 的 `minutesAgo` 与 en 的
 * `minutesAgo_one`/`_other` 视为同一基键。
 */
const PLURAL_SUFFIX = /_(one|other)$/;
const baseKey = (path: string) => path.replace(PLURAL_SUFFIX, '');
/** en 的两个 CLDR 复数类别——被复数化的基键必须两形齐全。 */
const EN_PLURAL_CATEGORIES = ['one', 'other'] as const;

const isEmpty = (r: object) => Object.keys(r).length === 0;

describe('en↔zh key 集对齐（增量发布门槛）', () => {
  for (const n of ns) {
    const zh = resources.zh[n];
    const en = resources.en[n];

    if (isEmpty(en)) {
      it.todo(`${n}：en 未翻译，待第 3 期填入`);
      continue;
    }

    it(`${n}：en 与 zh key 集完全一致（复数后缀归一）`, () => {
      const zhKeys = new Set(leafPaths(zh).map(baseKey));
      const enKeys = new Set(leafPaths(en).map(baseKey));
      const missing = [...zhKeys].filter((k) => !enKeys.has(k)); // zh 有 en 缺
      const extra = [...enKeys].filter((k) => !zhKeys.has(k)); // en 有 zh 无
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    });

    it(`${n}：en 复数键两形齐全（_one + _other）`, () => {
      const enPaths = leafPaths(en);
      const pluralBases = new Set(enPaths.filter((p) => PLURAL_SUFFIX.test(p)).map(baseKey));
      const incomplete = [...pluralBases].filter((base) =>
        EN_PLURAL_CATEGORIES.some((cat) => !enPaths.includes(`${base}_${cat}`)),
      );
      expect(incomplete).toEqual([]);
    });

    it(`${n}：en 无空值`, () => {
      const empties = leafEntries(en)
        .filter(([, v]) => typeof v === 'string' && v.trim() === '')
        .map(([k]) => k);
      expect(empties).toEqual([]);
    });
  }
});
