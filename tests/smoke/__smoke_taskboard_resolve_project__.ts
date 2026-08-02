/**
 * resolveProjectByTag 解析行为：
 *   1. 完全匹配 project.name → 命中
 *   2. 大小写忽略匹配 name → 命中
 *   3. basename 匹配（path 末尾段）→ 命中
 *   4. 多歧义（任一档命中多个）→ null
 *   5. 不命中 → null
 *   6. tag 空 / undefined → null（无 log）
 */
import './__smoke_isolate__';

import type { Project } from '@shared/types';
import { resolve } from '../../electron/main/taskboard/resolveProject';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

function mkProject(id: string, name: string, p: string): Project {
  return {
    id,
    ownerId: 'local-user',
    name,
    path: p,
    addedAt: 0,
    lastOpenedAt: 0,
    hasClaudeMd: false,
  };
}

async function main() {
  const projects: Project[] = [
    mkProject('p1', 'Oru', '/home/user/Documents/Oru-qa02'),
    mkProject('p2', '营销', '/home/user/Documents/marketing-site'),
    mkProject('p3', 'frontend-a', '/home/user/Documents/work/frontend-a'),
    mkProject('p4', 'frontend-b', '/home/user/Documents/work/frontend-b'),
  ];

  // case 1: 完全匹配 name
  assert(resolve('Oru', projects) === 'p1', '完全匹配 name "Oru" → p1');
  assert(resolve('营销', projects) === 'p2', '完全匹配 name "营销" → p2');

  // case 2: 大小写忽略匹配
  assert(resolve('oru', projects) === 'p1', '小写 "oru" 匹配 "Oru" → p1');
  assert(resolve('ORU', projects) === 'p1', '大写 "ORU" 匹配 "Oru" → p1');

  // case 3: basename 匹配（"qa02" 在路径 .../Oru-qa02 末段不命中——但 Oru-qa02 是 basename，
  //  所以 'Oru-qa02' / 'oru-qa02' 应该匹配）
  assert(resolve('Oru-qa02', projects) === 'p1', 'basename "Oru-qa02" 匹配 → p1');
  assert(resolve('oru-qa02', projects) === 'p1', '大小写 basename → p1');
  // 'qa02' 既不匹配 name 也不匹配 basename → null
  assert(resolve('qa02', projects) === null, '"qa02" 既非 name 也非 basename → null');

  // case 4: 多歧义
  // 加一个 name='Oru' 且不同 path 的项目，造成 name 完全匹配多个
  const ambiguousNames: Project[] = [
    ...projects,
    mkProject('p5', 'Oru', '/home/user/different-path'),
  ];
  assert(resolve('Oru', ambiguousNames) === null, 'name 多歧义 → null');

  // basename 多歧义（两个项目都以同 basename 结尾——构造同 basename）
  const ambiguousBase: Project[] = [
    mkProject('p1', 'A', '/home/user/p/foo'),
    mkProject('p2', 'B', '/home/other/foo'),
  ];
  assert(resolve('foo', ambiguousBase) === null, 'basename 多歧义 → null');

  // case 5: 不命中
  assert(resolve('inexistent', projects) === null, '不命中 → null');

  // case 6: 空 / undefined
  assert(resolve('', projects) === null, '空字符串 → null');
  assert(resolve('   ', projects) === null, '纯空白 → null（trim 后空）— resolve 内部不处理 trim，靠 caller; 这里直接传空白，按字面匹配为 false');

  // 汇总
  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\n=== ${RESULTS.length - failed.length}/${RESULTS.length} PASSED ===`);
  if (failed.length > 0) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
