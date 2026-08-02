---
id: deck-history
title: 演示稿版本历史与回退
area: deck
summary: 演示稿改动自动落版本，可在时间轴历史里找回任一旧版、回到此版本，会话内还能撤销重做
covers: [artifact_history_list, artifact_history_checkout]
source: docs/prd/2026-06-17-unified-history-and-annotation-submit-prd.md
---

演示稿的每次改动会自动落一个版本，能在时间轴历史面板里找回任一旧版、回到那个版本；历史每条带简述、"改了第几页"标签和缩略图。会话内也能 Ctrl+Z / Ctrl+Shift+Z 撤销重做。我自己也能列历史、切版本——切之前会先把当前未提交的改动存好，不丢工作。

**限制**：Ctrl+Z 撤不过当前版本的起点，更早的要走历史面板。版本只快照演示稿的 HTML、不快照里面的图片，所以切回引用了已删图片的旧版时会提示、需你确认后重切。

**怎么用**：在演示稿预览的历史面板按时间倒序挑一版"回到此版本"，或直接让我帮你回退。
