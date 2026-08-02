/**
 * Skill 模块 v1 smoke：覆盖压缩白名单、激活态重建、回声防护、unique 校验。
 *
 * 不打真 LLM——用 __setBackendFactoryForTest 替换。
 */
import './__smoke_isolate__';
import { compressIfNeeded } from '../../electron/main/agent/context/compress';
import { __setBackendFactoryForTest } from '../../electron/main/agent/backends/factory';
import { rebuildActivatedPlugins } from '../../electron/main/plugins/activatedState';
import {
  countOccurrences,
  buildDiffPreview,
  extractSkillDescription,
} from '../../electron/main/skills/manager';
import type { AgentBackend } from '@shared/agent/backend';
import type { ChatMessage } from '@shared/types';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
}

function mkUser(id: string, text: string): ChatMessage {
  return { id, conversationId: 'c1', role: 'user', text, toolCalls: [], createdAt: 0, done: true };
}
function mkAsst(id: string, text: string): ChatMessage {
  return { id, conversationId: 'c1', role: 'assistant', text, toolCalls: [], createdAt: 0, done: true };
}
function mkActivate(id: string, pluginId: string, errorMessage?: string): ChatMessage {
  return {
    id,
    conversationId: 'c1',
    role: 'system',
    text: `激活了 ${pluginId} plugin`,
    toolCalls: [],
    createdAt: 0,
    done: true,
    kind: 'plugin-activate',
    skillModuleAction: { id: pluginId, name: pluginId, errorMessage },
  };
}
function mkSkillCall(id: string, skillId: string): ChatMessage {
  return {
    id,
    conversationId: 'c1',
    role: 'system',
    text: `用了 ${skillId} skill`,
    toolCalls: [],
    createdAt: 0,
    done: true,
    kind: 'skill-call',
    skillModuleAction: { id: skillId, name: skillId },
  };
}

function makeSummaryBackend(): AgentBackend {
  return {
    backendType: 'anthropic',
    toolProtocol: 'anthropic-native',
    modelId: 'mdl_summary',
    providerId: 'prv_summary',
    runConversation: () => {
      throw new Error('not used');
    },
    runOneShot: async () => ({ text: '生成的摘要' }),
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: 'mock' }),
  };
}

async function run() {
  console.log('=== Skill 模块 v1 smoke ===');

  // ─── 1. rebuildActivatedPlugins ────────────────────────────
  const hist1: ChatMessage[] = [
    mkUser('u1', ''),
    mkActivate('act1', 'git-flow'),
    mkActivate('act2', 'broken', 'oh no'),
    mkSkillCall('sc1', 'merge-pr'),
    mkUser('u2', ''),
  ];
  const set = rebuildActivatedPlugins(hist1);
  assert(set.size === 1 && set.has('git-flow'), 'rebuildActivatedPlugins 排除错误激活', `actual: ${[...set].join(',')}`);

  // ─── 2. countOccurrences / buildDiffPreview / extractSkillDescription ───
  assert(countOccurrences('hello world hello', 'hello') === 2, 'countOccurrences 多次');
  assert(countOccurrences('abc', 'xyz') === 0, 'countOccurrences 零次');
  assert(countOccurrences('abc', '') === 0, 'countOccurrences 空 needle');
  const md = '---\nname: x\ndescription: foo bar\n---\n# body';
  assert(extractSkillDescription(md) === 'foo bar', 'extractSkillDescription 解析');
  const preview = buildDiffPreview('abc DEF ghi', 'DEF', 'XYZ');
  assert(preview.includes('[- DEF]') && preview.includes('[+ XYZ]'), 'buildDiffPreview 含 before/after 标记');

  // ─── 3. compress 白名单：plugin-activate 不被压缩 ──────────
  const restore = __setBackendFactoryForTest(async () => makeSummaryBackend());
  try {
    const longText = 'X'.repeat(50_000);
    const history: ChatMessage[] = [
      mkUser('u1', longText),
      mkAsst('a1', longText),
      mkActivate('act1', 'git-flow'),
      mkUser('u2', longText),
      mkAsst('a2', longText),
      mkActivate('act2', 'feishu'),
      mkUser('u3', longText),
      mkAsst('a3', longText),
      mkUser('u4', longText),
      mkAsst('a4', longText),
      mkUser('u5', longText),
      mkAsst('a5', longText),
      mkUser('u6', longText),
    ];
    const result = await compressIfNeeded({
      conversationId: 'c1',
      history,
      systemContext: '',
      threshold: 50_000 * 0.8,
      force: false,
    });
    if (!result) {
      assert(false, '压缩白名单：没触发压缩（预期触发）');
    } else {
      const trimmed = result.trimmedHistory;
      const activatedKept = trimmed.filter((m) => m.kind === 'plugin-activate');
      assert(
        activatedKept.length === 2,
        'plugin-activate chip 全部保留',
        `keep=${activatedKept.length}`,
      );
      assert(trimmed[0]?.kind === 'context-compressed', 'marker 仍在 idx=0');
      assert(
        trimmed[1]?.kind === 'plugin-activate' &&
          trimmed[1]?.skillModuleAction?.id === 'git-flow',
        'act1 紧跟 marker',
      );
      assert(
        trimmed[2]?.kind === 'plugin-activate' &&
          trimmed[2]?.skillModuleAction?.id === 'feishu',
        'act2 按时序排在 act1 之后',
      );
      const compressedIds = new Set(
        result.notificationMessage.contextCompressed?.compressedMessageIds ?? [],
      );
      assert(!compressedIds.has('act1') && !compressedIds.has('act2'), 'compressedMessageIds 排除白名单');
      // 重建激活态：从 trimmed history 仍能扫出两个 plugin
      const rebuilt = rebuildActivatedPlugins(trimmed);
      assert(rebuilt.size === 2 && rebuilt.has('git-flow') && rebuilt.has('feishu'), '压缩后激活态重建仍正确');
    }
  } finally {
    restore();
  }

  // ─── 总结 ───────────────────────────────────────────────────
  const fails = RESULTS.filter((r) => !r.ok);
  console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'}: ${RESULTS.length - fails.length}/${RESULTS.length} cases pass`);
  if (fails.length > 0) {
    console.log('Failed:');
    for (const f of fails) console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`);
    process.exit(1);
  }
}

void run();
