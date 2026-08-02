---
id: doc-markdown-export
title: 导出 Markdown 文档为 HTML 或 PDF
area: document
summary: 把在 Oru 里看到的这篇文档原样带出去——自包含 HTML 单文件或矢量 PDF
covers: []
source: docs/prd/2026-06-23-markdown-export-prd.md
---

把当前 Markdown 文档导出成可独立打开的文件：HTML（自包含单文件，双击即开，本地图、样式、公式、代码高亮全打进一个文件）或 PDF（文字可选可搜，不是图片）。

**限制**：只有 HTML 和 PDF 两种格式（不导 Word / PPT）；没有页边距 / 缩放 / 纸张尺寸 / 主题这些参数面板。PDF 只有一个「纸张版（A4）」开关——默认关是书本式连续排版，开是 A4 论文式分页。导出不改源文档；空文档会被拦下；重名自动加序号、不覆盖。

**怎么用**：在编辑器顶栏历史按钮旁的「导出」下拉里选 HTML 或 PDF，导出后会在访达里选中该文件。注意：这是导出**文档**；导出**演示稿**为 PPT/PDF 是另一条能力。
