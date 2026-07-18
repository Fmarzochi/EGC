<!-- LANGUAGE-SELECTOR-START -->
🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Español](../es/README.md) · [हिन्दी](../hi/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · **简体中文**
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC)

<div align="center">
# EGC - Extended Global Context

**让你的 AI 智能体告别从零开始。**

*零配置。零命令。你只管工作，记录由EGC来办。*

</div>

---

EGC是一款为所有 AI 编程工具适配的本地运行环境，能为你的项目开发提供持久化记忆。会话结束时，AI 会自动沉淀会话中的项目细节，包括决策过程、报错记录、个人偏好以及后续计划。再次开启会话时，无需任何提示即可自行加载上下文状态。无论你说“继续执行”或“上次进度到哪了？”，AI 都能心领神会。只需一次安装，即可适配 Claude Code、Cursor、Gemini CLI、Windsurf、Zed、Warp、JetBrains Junie、VS Code（搭载 GitHub Copilot）等 20 多款工具。它不仅原生支持 Claude、GPT-4o、Gemini、DeepSeek 与 Mistral 等 AI 模型，Groq、Cohere 与 Vertex AI 等 AI 平台，还能通过 OpenRouter 接入 Qwen3、Llama 4 等更多模型。

---

## 你的 AI 对此早已了然于胸

打开一个在 Claude Code 里搁置两周的项目，无需进行任何输入，你就能看到如下内容：

```
State loaded from egc-memory via ~/.egc/state/MyApp/main.md

Context and preferences acknowledged.

Ready to pick up:
• Fix the rate limiter edge case on concurrent requests
• Add integration tests for the new auth module
• Review open PR from @contributor before merging

=== EGC Stack Briefing ===
Stack: typescript, node
Skills: tdd-workflow, coding-standards
Agents: code-reviewer
Guardian: active, every command checked before it runs
===
```

这超越了简单的对话缓存逻辑。EGC 谨记着你的开发决策、规避方案以及个人偏好，并作为全程的安全守卫，在危险命令执行前予以拦截，防止代码库损坏。无需任何额外配置，你可以专注开发。

<div align="center">
  <img src="../../assets/egc-terminal.gif" alt="EGC demo" width="700" />
</div>

---

## 安装

Windows、macOS 和 Linux 下的安装命令完全一致：

```bash
npm install -g @egchq/egc && egc install
```

Windows 有一些特殊限制（例如 PowerShell 版本、Antigravity CLI、已失效的 Gemini CLI 免费版）：如果遇到问题，请参阅 [Windows 说明](../../docs/installation.md#windows-notes)。

或者直接运行，无需全局安装：

```bash
npx @egchq/egc install
```

**一个核心，多端联动。** 只需安装 GitHub Copilot Chat 扩展，Copilot 便能自动识别相关技能；同时，你在 Claude Code 或 Cursor 中积累的上下文记忆也将实时同步：

```bash
npm install -g @egchq/egc
egc install --target copilot
```

[完整安装指南](../../docs/installation.md)

---

## EGC 能为你的 AI 助手提供什么

每次运行 EGC 时，它都在后台同步执行两项任务：记忆持久化，用于保留所有关键语境；安全风控，在危险操作执行前自动拦截。一切开箱即用，无需繁琐配置。

### 记忆：AI 自主沉淀的项目经验

告别繁琐的记忆指令。无论是“对齐昨日进度”、“记录当前决策”还是“回顾上次失败原因”，你的 AI 都能心领神会。你只管工作，记忆交给 EGC 来办。

**`egc-memory`**

| 工具 | 功能 |
|---|---|
| `get_state` | 开启会话时，即刻同步 AI 已掌握的项目背景及用户的全局长期记忆 |
| `update_state` | 记录今日决策，确保明日工作无缝衔接；`scope: "global"` 可跨项目共享这些上下文 |
| `session_announce` / `session_peers` | 各并行会话彼此可见，自动划分工作区，避免运行冲突 |
| `claim_path` / `release_path` | 引入协作锁机制，确保多个会话不会因同时操作相同文件而产生冲突 |
| `store_decision` | 永久记录一项重要决策 |
| `query_history` | 按时间顺序回顾历史决策记录 |
| `search_history` | 就算不记得日期，它也能找回曾经做过的每一项决策 |
| `working_memory_set` / `_get` / `_list` | 随用随记、到期后自动失效的临时笔记 |
| `lesson_save` | 记录学习到的知识，若未经再次确认，这些记忆将随时间流逝而淡化 |
| `lesson_recall` | 提取仍具有实践价值的经验教训 |
| `lesson_reinforce` | 当经验再次得到确证时，予以强化 |
| `detect_patterns` | 对持续重复出现的错误或指令，会自动识别并提醒 |
| `compress_observations` | 自动归纳历史会话记录，避免产生不必要的 Token 开销 |
| `get_project_state` | 验证上下文记忆功能是否正常运行 |

项目的每个分支均拥有独立记忆，并在本地进行加密存储：无论是云端还是其他任何人都无法访问。原生隐私设计，无需额外配置。

### 上下文与安全：为项目开发提供实时保障

**`egc-guardian`**

这些工具在后台独立运行。在执行前，每一个 Shell 命令和文件写入操作都经严格安全审计。无需你手动调用。

| 工具 | 功能 |
|---|---|
| `validate_command` | 在执行前自动审核所有命令，拦截并阻止潜在的风险操作 |
| `validate_write` | 防止 AI 因误操作向敏感文件写入内容 |
| `reduce_context` | 压缩大文件，避免无谓消耗 Token 预算 |
| `orchestrate_task` | 自动为每个请求匹配最合适的工具，无需手动记忆或挑选可用工具 |
| `auto_learn` | 记录并吸取会话中的失败教训，防止类似错误再次发生 |

### Token 优化器：告别终端无用输出带来的 Token 浪费

面对 200 条 `git log`提交记录、400 行 `npm install`安装日志或是包含 300 个测试通过的报告，你的模型会照单全收，而你则需要为这笔庞大的 Token 支出买单。Token 优化器在这些输出**到达模型之前**就将其压缩：体积最多缩减 90%，并确保错误、警告及失败条目被完整保留。

```
egc run git log        # same command, crushed output
egc run --raw git log  # escape hatch: full output
egc saved              # accumulated savings, computed locally at zero token cost
```

设计上保持稳健：较短输出原样保留，故障记录持久化存储，这一精简压缩策略绝不占用您的上下文窗口。

### 代码硬性约束，而非指令引导

安全保障不再依赖于 AI 的“状态”：所有命令在执行前必经 EGC 审核。[点击了解有关 harness 应用、意图识别及记忆提取机制的详细方案 →](../../docs/installation.md#enforcement)

### 统一的持久化记忆，告别跨工具碎片化

只需运行一次 **`egc watch`**，即可静默生效。无论是在 Cursor 中切换上下文，还是使用 Gemini CLI、Copilot、Windsurf 或 Zed，它都会通过自动同步贯穿你的所有开发工具。无需手动操作，确保各处版本始终实时更新。

```
egc watch              # watch current project
egc watch /path/proj   # watch a specific project
egc watch --quiet      # suppress output
```

### 控制面板：实时掌握智能体工作状态

直接在浏览器中实时监控 AI 代理生成的每个命令、消耗的 Token 及对应成本。执行 `egc init` 后即可自动开启。[查看完整指南](../../docs/installation.md#dashboard)

---

## 提示词库

除此之外，EGC 还附带了 63 个智能体、230 项技能、77 条内部命令和 111 条预设规则。这些资源包含能够自动审阅代码的专家工具、针对各种语言和场景的最佳实践指南、可一键执行复杂任务序列的快捷指令，以及保持代码规范的一系列风格准则。所有功能均基于真实工程案例提炼，而非纸上谈兵。当然，这些都是可选的，即使不使用他们，EGC 的核心功能持久化记忆依然可以独立运作。

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Español](../es/README.md) · [हिन्दी](../hi/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · **简体中文**

---

## 支持 EGC

EGC 是一个由社区成员独立开发并公开维护的开源免费项目。

- **[官网](https://fmarzochi.github.io/EGCSite)**：包含完整文档、功能概览与在线演示
- **[加入 Discord](https://discord.gg/AtazrtxJ)**：在这里提问并分享您的反馈意见
- **[在 GitHub 上支持本项目](https://github.com/sponsors/Fmarzochi)**：金额不限，每一份支持都很重要
- **[通过 PayPal 捐赠](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**：无需 GitHub 账号
- **点个 Star 关注**：让更多开发者发现此项目
- **[参与贡献](../../.github/CONTRIBUTING.md)**：开发 Agent、技能、命令、修复 Bug 以及完善文档
- **分享**：如果 EGC 改变了你的工作方式，欢迎向他人推荐

### 赞助者

社区的支持是维持本项目生命力与独立性的基石。

#### 工具合作伙伴

与 EGC 原生集成的 AI 辅助编程工具。合作伙伴的 Logo 将会在所有项目的 README 文档和 EGCSite 官网上集中展示。

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### 年度赞助 · _虚位以待，期待首个年度赞助。_

---

#### 支持者

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>

#### 月度赞助者 · _虚位以待_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
