---
id: ext-plugin-skill
title: 安装和使用插件 / skill
area: extensions
summary: 从 GitHub 或本地文件夹装插件 / skill、按任务自动激活来干活，其余时候零开销
covers: [plugin_list, propose_plugin_install, propose_plugin_uninstall, propose_skill_install, propose_skill_install_local, activate_plugin, read_skill]
source: docs/prd/2026-05-24-skill-module-prd.md
---

skill 是一套教我怎么做某类事的指令包，plugin 是一组 skill 的集合。你可以让我从 GitHub 装一个插件或独立 skill（我先帮你找到地址、探测内容再递安装提案），也可以给我一个**本地文件夹**（比如你从聊天里下载好的 skill）让我装进来。装了之后我会在任务相关时**自动激活**对应插件、读取它的 skill 来做事，其余时候零开销。

你也可以自己把一个 skill 文件夹直接放进扩展目录——我会察觉到并即时加载，不用重启（个别系统上需要你打开一次扩展页让我对账）。

装的过程**我会等到真结果再回话**：装好了才说装好了、装不上会告诉你卡在哪（仓库找不到、SKILL.md 缺字段、目录已存在等），不会先回一句「已提交」再也没下文。

**限制**：安装 / 卸载都走审批挡位——工作挡下提案卡**等你点确认才动手**，危险挡直接执行（装好的 skill 当轮就能用），只读挡直接拒。装卸状态由审批卡终态承载——我在对话里会用文字交代「装好 / 没装上 / 卡在哪一步」，不再单独发一张汇报小卡。激活的准确度取决于插件自己写的激活描述。

**怎么用**：在对话里让我装某个插件 / skill（GitHub 地址或本地路径都行）；问"你装了哪些插件"我会实时查。要让我**写一个新 skill**，见「把跑通的流程存成 skill」。
