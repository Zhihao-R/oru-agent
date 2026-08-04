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

# 规则 2：命名语义色（accent/danger/success/warn 及全部 token）均已走 tokenColor 以 color-mix
# 暴露 <alpha-value>，/N 对它们有效——不再是死类。仅「[] 任意值里的裸 var(--x) + /N」仍会失效
# （tailwind 对不含 <alpha-value> 的裸 var 任意值不生成 /NN），这类才拦。
hits=$(grep -rEn '\[[^]]*var\(--[^)]*\)[^]]*\][^[:space:]?/]*/[0-9]' src/ 2>/dev/null)
if [ -n "$hits" ]; then
  echo "✗ [死类] 裸 var(--x) 任意值搭配 /N 透明度类不生成（named 语义色已 tokenColor 化，/N 有效）："
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

# 规则 4：mock 禁用 `as (unknown as )?(ToolContext|Settings)` 整对象强转逃生舱——接口加必填字段时假绿。
# 单层与双层都堵：一律走工厂 tests/helpers/{toolContext,settings}.ts（内部 satisfies 收口），
# 完整对象也可改 satisfies。helper 自身豁免。
# 只拦「整对象 as Settings」——`Settings['...']` 索引类型访问不是逃生舱（如注入已下架枚举值测回落），不误报。
# 边界含空白/分号/)/,/]/}：覆盖参数、数组/对象字面量等容器形态，堵整对象强转的一切出口。
hits=$(grep -rEn 'as (unknown as )?(ToolContext|Settings)([[:space:];\)\],}]|$)' tests/ 2>/dev/null \
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
