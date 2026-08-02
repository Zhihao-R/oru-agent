/**
 * diff3 —— 文本三方合并纯函数（块②核心，tech §3.2/§7）。
 *
 * 放在 @shared：渲染端（编辑器冲突卡）与主进程（S27 锁内机械合并 workfileWrite）共用同一份内核，
 * 两侧各经 `@shared/diff3` import——合并语义只此一处，杜绝两进程各写一套合并致口径漂移。
 *
 * 以 base 为你和 Oru 共同的出发版，分别比对 mine / theirs 的行级改动再归并：不同段各改 → 自动合并；
 * 同段都改且不同 → 冲突。算法忠实移植成熟的 node-diff3「两路 2-way diff（base→mine、base→theirs）
 * 按 base 行坐标排 hunk、重叠区段并块比对」（业界久经验证，避免自创合并内核的正确性风险）。
 *
 * 行级而非字符级：PRD 已确认文档用成熟逐行合并、表格因二维冲突不做合并。逐行对大段行偏移可能产出
 * 非最优合并，文档场景可接受（tech §9 已知风险）。
 *
 * 输出契约：
 *  - merged：非冲突区自动合并的结果；冲突区**保留 mine 版**（PRD「未做选择前文件保持你的版本」）。
 *  - conflicts[].range：该冲突段在 merged 中的字符区间（mine 版的落点，供编辑器原地挂对照卡）。
 *  - mineText/theirsText/baseText：该段三个版本的整段文本（含行尾），供对照卡展示与三动作 changeset。
 */
import { diffArrays } from 'diff';

export type Diff3Conflict = {
  range: { from: number; to: number };
  mineText: string;
  theirsText: string;
  baseText: string;
};

export type Diff3Result = {
  merged: string;
  conflicts: Diff3Conflict[];
};

/** 切成行数组，每行保留其行尾 '\n'（末行可能无）。空串 → 空数组。 */
function splitLines(s: string): string[] {
  if (s === '') return [];
  return s.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

type Region = { baseLo: number; baseHi: number; sideLo: number; sideHi: number };

/** base→side 的差异区段：base 行索引 [baseLo,baseHi) ↔ side 行索引 [sideLo,sideHi)。 */
function diffRegions(base: string[], side: string[]): Region[] {
  const parts = diffArrays(base, side);
  const regions: Region[] = [];
  let bi = 0;
  let si = 0;
  let i = 0;
  while (i < parts.length) {
    if (!parts[i].added && !parts[i].removed) {
      const n = parts[i].count ?? parts[i].value.length;
      bi += n;
      si += n;
      i++;
      continue;
    }
    // 收集连续的 removed（在 base 不在 side）/ added（在 side 不在 base）成一个差异区段
    const baseLo = bi;
    const sideLo = si;
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      const n = parts[i].count ?? parts[i].value.length;
      if (parts[i].removed) bi += n;
      else si += n;
      i++;
    }
    regions.push({ baseLo, baseHi: bi, sideLo, sideHi: si });
  }
  return regions;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

type Hunk = { side: 0 | 2; oStart: number; oEnd: number; sStart: number; sEnd: number };

export function diff3(baseStr: string, mineStr: string, theirsStr: string): Diff3Result {
  const base = splitLines(baseStr);
  const mine = splitLines(mineStr);
  const theirs = splitLines(theirsStr);

  const hunks: Hunk[] = [];
  for (const r of diffRegions(base, mine))
    hunks.push({ side: 0, oStart: r.baseLo, oEnd: r.baseHi, sStart: r.sideLo, sEnd: r.sideHi });
  for (const r of diffRegions(base, theirs))
    hunks.push({ side: 2, oStart: r.baseLo, oEnd: r.baseHi, sStart: r.sideLo, sEnd: r.sideHi });
  hunks.sort((a, b) => a.oStart - b.oStart || a.side - b.side);

  const mergedLines: string[] = [];
  const conflicts: Diff3Conflict[] = [];
  let commonOffset = 0; // 已消费到的 base 行索引

  const push = (lines: string[]): void => {
    for (const l of lines) mergedLines.push(l);
  };
  const copyCommon = (target: number): void => {
    if (target > commonOffset) {
      push(base.slice(commonOffset, target));
      commonOffset = target;
    }
  };

  for (let hi = 0; hi < hunks.length; hi++) {
    const first = hi;
    let regionLhs = hunks[hi].oStart;
    let regionRhs = hunks[hi].oEnd;
    // 把后续与本区段**真重叠**（共享至少一行 base，oStart 严格 < regionRhs）的 hunk 并进同一区段。
    // 相邻（oStart == regionRhs）非重叠——是两处独立的单侧改，各自自动合并，不并成冲突。
    while (hi < hunks.length - 1 && hunks[hi + 1].oStart < regionRhs) {
      regionRhs = Math.max(regionRhs, hunks[hi + 1].oEnd);
      hi++;
    }
    copyCommon(regionLhs);

    if (first === hi) {
      // 区段仅一侧改（另一侧 == base）→ 取改的那侧（自动合并）
      const h = hunks[hi];
      if (h.sEnd > h.sStart) push((h.side === 0 ? mine : theirs).slice(h.sStart, h.sEnd));
      commonOffset = regionRhs;
    } else {
      // 区段两侧都涉及 → 把各侧区间按公共区段边界对齐展开，再并块比对
      const bound: Record<0 | 2, [number, number]> = {
        0: [mine.length, -1],
        2: [theirs.length, -1],
      };
      for (let k = first; k <= hi; k++) {
        const h = hunks[k];
        const r = bound[h.side];
        r[0] = Math.min(r[0], h.sStart - (h.oStart - regionLhs));
        r[1] = Math.max(r[1], h.sEnd + (regionRhs - h.oEnd));
      }
      const aRegion = mine.slice(bound[0][0], bound[0][1]);
      const bRegion = theirs.slice(bound[2][0], bound[2][1]);
      if (arraysEqual(aRegion, bRegion)) {
        push(aRegion); // 两侧改成一样——非真冲突，取其一
      } else {
        const from = mergedLines.join('').length;
        push(aRegion); // 冲突处 merged 保留 mine 版
        const to = mergedLines.join('').length;
        conflicts.push({
          range: { from, to },
          mineText: aRegion.join(''),
          theirsText: bRegion.join(''),
          baseText: base.slice(regionLhs, regionRhs).join(''),
        });
      }
      commonOffset = regionRhs;
    }
  }
  copyCommon(base.length);

  return { merged: mergedLines.join(''), conflicts };
}
