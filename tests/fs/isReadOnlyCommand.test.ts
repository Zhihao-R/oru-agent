/**
 * isReadOnlyCommand 白名单判定（只读重构 PRD §2.2 / 技术设计 §4 Spike 2）。
 *
 * 方向 = 正向举证（基命令在册 AND 无写重定向 AND 无写选项），fail-closed：看不透 / 不在册一律判非只读。
 * 重点覆盖第三态命令（make / git log --output / 任意 `> file`）——它们既不破坏也不只读，必须判非只读。
 */
import { describe, expect, it } from 'vitest';
import { isReadOnlyCommand } from '../../electron/main/fs/bashCommand';

const ro = (cmd: string) => isReadOnlyCommand(cmd).ok;

describe('isReadOnlyCommand — 只读放行', () => {
  for (const c of [
    'ls',
    'ls -la /tmp',
    'cat foo.txt',
    'pwd',
    'git status',
    'git log',
    'git log --oneline',
    'git diff HEAD~1',
    'git show abc123',
    'grep -r foo .',
    'cat a 2>&1', // fd 复制不算写
    'cat a.txt | grep foo | wc -l', // 管道逐段都只读
    'find . -name "*.ts"', // 普通 find（带 -exec/-delete 才非只读）
    'head -n 20 file.log',
    'echo hello', // 只写 stdout
    'wc -l < file.txt', // 输入重定向不是写
    'cat a > /dev/null', // 丢弃到 /dev/null 不算写
  ]) {
    it(`只读：${c}`, () => {
      expect(ro(c)).toBe(true);
    });
  }
});

describe('isReadOnlyCommand — 非只读直接拒（写类 / 第三态 / 看不透）', () => {
  for (const c of [
    'rm foo.txt',
    'rm -rf build',
    'echo hi > f.txt', // 写重定向
    'echo hi >> f.txt',
    'git commit -m x', // 写子命令
    'git add .',
    'git push',
    'git log --output=f', // 第三态：只读子命令 + 写 flag
    'git log --output f',
    'git log -o f',
    'make', // 第三态：不在册
    'make build',
    'npm install',
    'node script.js', // 解释器：能跑任意代码
    'python -c "print(1)"',
    'mkdir newdir',
    'touch newfile',
    'mv a b',
    'cp a b',
    'ls; rm foo', // 任一段非只读则整条非只读
    'ls && rm foo',
    '$(rm -rf /)', // 命令替换看不透
    '`whoami`',
    'cat foo & ', // 后台执行看不透
    'eval "ls"', // eval 看不透
    'sh -c "ls"', // shell -c 看不透
    'sort -o out.txt in.txt', // 写选项（故意不在白名单）
    'tee out.txt', // 写文件命令
    'find . -name "*.ts" -fprint /tmp/out', // find 原生写文件 action（非 shell 重定向）
    'find . -fprint0 /tmp/out', // 同上，-fprint0
    'find . -delete', // find 删除 action
  ]) {
    it(`非只读：${c}`, () => {
      expect(ro(c)).toBe(false);
    });
  }
});
