import type { Plugin } from 'unified';
import type { MarkdownExtension } from '@lezer/markdown';
// 仅引类型增强：remark-parse 在 'unified' 的 Data 接口上补了 micromarkExtensions 字段，
// 本文件未 import remark-parse 的值，故增强不进类型图、data.micromarkExtensions 报不存在。
import type {} from 'remark-parse';

/**
 * Oru 的 Markdown「方言」单一来源。
 *
 * 编辑态（CodeMirror / lezer）与渲染态（react-markdown / micromark）是两套独立解析器：
 * 一套服务「可编辑」——增量语法树 + 光标位置映射 + 装饰；一套服务「产出展示物」——
 * 导出文件与聊天气泡。二者各司其职、无法也不该合并成一个引擎。但它们对「同一段 md
 * 到底是什么意思」必须口径一致，否则编辑器里看到的样子会和导出 / 聊天里渲染的打架。
 *
 * 所以语法开关收在这里成对维护：每新增一处方言分歧（某语法在 Oru 里关掉），就在本文件
 * 同时给出两套引擎的对应配置，别散落到各组件——两套引擎的关法不同（lezer 按节点名 remove、
 * micromark 按 construct 名 disable），但并排放一处，漏配一边的概率才压得下去。
 *
 * 当前唯一分歧：关掉 setext 下划线标题——正文紧跟一行 `-` / `=`（中间无空行）会把上一段
 * 升格成标题。反直觉、易误触（换行想打列表 `-`，结果整段变粗变大），社区口碑差；`#` 井号
 * 式标题（ATX）完全不受影响。
 */

// 编辑态：lezer 里 setext 是名为 'SetextHeading' 的 leaf block（占位登记在 blockNames 中）。
// remove 按名查到后会把对应 block / leaf parser 一并置空。
export const lezerDialect: MarkdownExtension = { remove: ['SetextHeading'] };

// 渲染态：micromark 里 setext 是名为 'setextUnderline' 的 construct。本插件在解析前把它推进
// disable.null 关掉。须是普通函数——箭头函数拿不到 unified processor 的 this。
export const remarkDialect: Plugin<[]> = function () {
  const data = this.data();
  const list = data.micromarkExtensions || (data.micromarkExtensions = []);
  list.push({ disable: { null: ['setextUnderline'] } });
};
