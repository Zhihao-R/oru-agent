---
id: ext-skill-author
title: 把跑通的流程存成 skill
area: extensions
summary: 复杂任务做通后让我把这套流程写成一个新 skill 以后复用，也能小修已有 skill
covers: [skill_manage]
source: docs/prd/2026-05-24-skill-module-prd.md
---

一个复杂任务跑通后，你说"把这个流程存下来"，我能把它写成一个新的 skill 供以后复用；也能对已有 skill 做小修。写盘完成我才回话——落好了才说落好了，写不进去会告诉你为什么（重名、目标文件找不到等）。

**限制**：走审批挡位（只读挡不能写）。新写或改过的 skill **当前这轮对话不生效、下次才加载**。小修时要替换的原文必须在目标文件里唯一出现，否则我会直接报错、不进审批。

**怎么用**：在对话里让我"把刚才这套流程存成 skill"，或让我改某个已有 skill。
