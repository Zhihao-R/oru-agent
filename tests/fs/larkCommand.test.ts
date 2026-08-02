/**
 * lark-cli 破坏性命令结构化识别（三方平台 tech §7 / §11 对抗）。
 *
 * 核心：写子命令永远在位置参数上，绝不在 --flag 的值里。只扫「lark-cli 之后、第一个 - 之前」
 * 的位置 token（逐 token 去引号字符）——既挡引号绕过（lark-cli docs "+create"），
 * 又不被 --query "how to create" 这类参数值误伤。判定走 analyzeCommand（生产同一入口）。
 */
import { describe, expect, it } from 'vitest';
import { analyzeBashCommand } from '../../electron/main/fs/bashCommand';

const destructive = (cmd: string) => analyzeBashCommand(cmd).isDestructive;

describe('lark-cli 写命令 → 破坏性', () => {
  for (const c of [
    'lark-cli docs +create --content "hi"',
    'lark-cli docs +update --doc-id x',
    'lark-cli docs +whiteboard-update --doc-id x',
    'lark-cli docs +media-insert --doc-id x',
    'lark-cli docs +media-upload --file a.png',
    'lark-cli docs resource-update --type cover',
    'lark-cli docs resource-delete --type cover',
    'lark-cli base record create --params "{}"',
    'lark-cli api POST /open-apis/docx/v1/documents',
    'lark-cli api DELETE /open-apis/x',
  ]) {
    it(`破坏性：${c}`, () => {
      expect(destructive(c)).toBe(true);
    });
  }
});

describe('lark-cli 写命令引号 / 包装变体 → 仍破坏性（抗绕过）', () => {
  for (const c of [
    'lark-cli docs "+create" --content "hi"',
    "lark-cli docs '+create' --content hi",
    'timeout 60 lark-cli docs +create --content hi',
    'LARK_FOO=bar lark-cli docs +create',
    // 子命令前塞全局 flag 不能绕过（+写动作全局扫描兜底）
    'lark-cli --token abc docs +create --content hi',
    'lark-cli -t abc docs "+media-upload" --file a.png',
  ]) {
    it(`破坏性：${c}`, () => {
      expect(destructive(c)).toBe(true);
    });
  }
});

describe('lark-cli 读命令 → 放过（参数值含写词也不误伤）', () => {
  for (const c of [
    'lark-cli docs +fetch --doc-id x',
    'lark-cli docs +search --query "how to create a doc"',
    'lark-cli docs +media-download --doc-id x',
    'lark-cli docs +media-preview --doc-id x',
    'lark-cli docs resource-download --type cover',
    'lark-cli base record list',
    'lark-cli api GET /open-apis/calendar/v4/calendars',
    'lark-cli skills read lark-doc',
    'lark-cli auth status',
  ]) {
    it(`放过：${c}`, () => {
      expect(destructive(c)).toBe(false);
    });
  }
});
