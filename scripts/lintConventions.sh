#!/usr/bin/env bash
# 约定 lint：把"踩过的坑"固化成机器检查（教训→规则，每条新教训进 MEMORY 时同步加一条）。
# 接进 test:all 与 CI；任何一条命中即失败并打印位置。
# 不加 set -e：grep exit 1 = 无匹配是正常路径，失败只看 fail 变量。
set -u
cd "$(dirname "$0")/.."
fail=0

# 规则 1：warning 是死 token（tailwind 注册的是 warn）——曾积累 21 处静默无色
hits=$(grep -rEn '\b(text|bg|border)-warning\b' src/ 2>/dev/null)
if [ -n "$hits" ]; then
  echo "✗ [死类] warning 不是注册 token，用 warn / warn-soft："
  echo "$hits"
  fail=1
fi

# 规则 2：/N 透明度类对 var() 颜色全不生成——淡底用 -soft token、聚焦环用 accent-ring
hits=$(grep -rEn '(text|bg|border|ring)-(accent|danger|success|warn)/[0-9]' src/ 2>/dev/null)
if [ -n "$hits" ]; then
  echo "✗ [死类] /N 透明度类对 var() 颜色无效，淡底用 -soft token、聚焦环用 accent-ring、hover 用 opacity："
  echo "$hits"
  fail=1
fi

# 规则 3：...process.env 只允许在两处出现（子进程 env 必须走 buildSubprocessEnv，
# 防 ANTHROPIC_BASE_URL 劫持回归；mcp/client.ts 是注释过的刻意例外）
hits=$(grep -rln --include='*.ts' -e '\.\.\.process\.env' electron/ 2>/dev/null \
  | grep -Fxv -e 'electron/main/engine/subprocessEnv.ts' -e 'electron/main/mcp/client.ts')
if [ -n "$hits" ]; then
  echo "✗ [env] 子进程 env 构造必须走 buildSubprocessEnv（剥 ANTHROPIC_BASE_URL）："
  echo "$hits"
  fail=1
fi

# 规则 4：mock 禁用 `as (unknown as )?(ToolContext|Settings)` 强转逃生舱——接口加必填字段时假绿。
# 单层与双层都堵：一律走工厂 tests/helpers/{toolContext,settings}.ts（内部 satisfies 收口），
# 完整对象也可改 satisfies。helper 自身豁免。
hits=$(grep -rEn 'as (unknown as )?(ToolContext|Settings)\b' tests/ 2>/dev/null \
  | grep -v '^tests/helpers/')
if [ -n "$hits" ]; then
  echo "✗ [mock] 禁用 as (unknown as) ToolContext/Settings——用 makeToolContext / makeSettings（tests/helpers/），或对完整对象改 satisfies："
  echo "$hits"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "✓ lint:conventions 全部通过"
fi
exit $fail
