<!-- LANGUAGE-SELECTOR-START -->
🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · **简体中文**
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - 每个 AI Agent 的共享智脑

**专为 AI 会话打造，自动跨 Agent 、IDE、终端同步的持久记忆中枢。无需复杂 prompt ，无需重建上下文，无需学习。**

</div>

---

作为AI中台，EGC 绝非又一个平庸的记忆工具，它针对 AI 工作流原生打造，让每个AI Agent都能如指臂使，适用于 Cursor、Copilot、Claude Code、Codex、Aider 等 20 种 AI IDE 及终端 Agent 。EGC 原生支持 Claude、GPT-4o、Gemini、DeepSeek 与 Mistral 等 AI 模型，以及 Groq、Cohere 和 Vertex AI 等 AI 平台，还能通过 OpenRouter 接入 Qwen3、Llama 4 等更多模型。

每轮交互都为项目沉淀群体智能。每个 Agent 都与之对齐。每次会话都提升更多效能。

---

## 安装

```bash
npm install -g @egchq/egc && egc install
```

- **至多减少 90%冗余 token，大幅降低成本，确保 AI 在各会话间状态同步。**
- **Guardian 组件：命令执行前主动校验，自动拦截危险写入行为，智能识别提示注入攻击。为每个 Agent 提供安全防护。**
- **一键启动，无需配置：记忆仅在本地加密存储，绝不误入 Git 仓库。**

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="One command installs EGC across 20 AI coding tools" width="800" />
</div>
[完整安装指南](../../docs/installation.md)

---

## 核心机制：EGC 运作原理

EGC 并非工具的简单组合。它统合多种官能：记忆、理解、守护、过滤、协调，是统筹多 Agent 工作流的共享智脑。

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### 无需死记硬背 prompt ，像日常对话一样自然交流

随时用自然语言与智脑对话，例如：“保存当前进度”、“之前我们聊的身份验证方案是什么”、“记住这个决定”。EGC 能够精准理解意图，自动存储上下文，并在设备上的任意标签页、终端或工具中实现无缝同步、毫秒级调用。一个中枢，多端联动。无需记忆。

### 项目记忆持久化

数据中台：每个 AI Agent 都可接入。它谨记着你的决策、上下文语境、工作记忆与习得模式，通过自动同步贯穿你的所有开发工具。各会话状态、项目语境与经验可在不同标签页、工具及团队成员间无缝流转：无需手动同步，杜绝上下文丢失。所有记忆存储在本地 `~/.egc` 文件夹中，采用 AES-256-GCM 加密，依照项目分支独立保存，且绝不会被提交进你的仓库。

### Guardian：内置安全防护组件

海面下不可见的冰山：作为守护进程，Guardian 组件在智脑后台静默运行。主动校验命令、拦截高危写入、在上下文溢出前压缩、跨 agent 编排多步任务、从每次纠正中自我进化，这一切都无需手动操作。天网恢恢疏而不漏，这一机制让 EGC 在精简上下文的同时确保操作安全，支撑工作流长期自主运行。

### Token 优化器：存储记忆前，自动过滤噪声

智脑不只是记忆中枢：EGC 也过滤噪声。在 Shell 输出送达模型前，EGC 的 Token 优化器至多能够减少 90% 的冗余 token，避免 git 日志、冗余测试信息、安装日志和庞大的全量 JSON 数据带来的 token 浪费，并精准保留所有错误与警告细节。运行 `egc saved` 即可查看 token 节省总量，计算仅在本地零成本进行：这不仅降低对话成本，更在事实上扩展了可用上下文。

---

## 提示词库

作为附加福利，EGC 还附赠 63 个 Agent、230 项技能、77 条内部命令，外加 111 条预设规则：这些资源包含能够自动审阅代码的专家工具、针对各种语言和场景的最佳实践指南、可一键执行复杂任务序列的快捷指令，以及维护代码规范的一系列风格准则。所有功能均源自真实的工程实践，而非单纯的理论推演。当然，这些都是可选的，即便不使用它们，EGC 的核心功能（**持久化记忆**）依然可以独立运作。

---

## 快速上手

只需运行一次 `egc watch`，即可静默生效：

```bash
egc watch
```

在 Cursor 中修改上下文，更改会自动同步到已配置的 Gemini CLI、Copilot、Windsurf、Zed 或任何终端 Agent 中。无需手动操作，告别状态延迟。

在浏览器中实时监控 Agent 的工具调用详情、消耗的 Token 及对应成本：

```bash
egc dashboard
```

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · **简体中文**

---

## 支持 EGC

EGC 是一个由社区成员独立开发，公开维护的开源免费项目。

- **[官网](https://fmarzochi.github.io/EGCSite)**：包含完整文档、功能概览与在线演示
- **[加入 Discord](https://discord.gg/TxppsGb52)**：在这里提问并分享您的反馈意见
- **[在 GitHub 上赞助](https://github.com/sponsors/Fmarzochi)**：金额不限，每一份支持都很重要
- **[通过 PayPal 捐赠](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**：无需 GitHub 账号
- **点个 Star 关注**：让更多开发者发现此项目
- **[参与贡献](../../.github/CONTRIBUTING.md)**：开发 Agent、技能、命令、修复 Bug 以及完善文档
- **分享**：如果 EGC 改变了你的工作方式，欢迎向他人推荐

### 赞助者

社区支持是维持本项目生命力与独立性的基石。

#### 工具合作伙伴

与 EGC 原生集成的 AI 辅助编程工具。合作伙伴的 Logo 将会在所有项目的 README 文档和 EGCSite 官网上集中展示。

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### 年度赞助者 · _虚位以待，期待首个年度赞助_

---

#### 支持者

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>
<a href="https://github.com/jackmcwin"><img src="https://avatars.githubusercontent.com/u/135963880?v=4" width="52" height="52" alt="@jackmcwin" title="@jackmcwin, Chinese Simplified translation" /></a>

#### 月度赞助者 · _虚位以待_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
