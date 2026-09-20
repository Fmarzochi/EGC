<!-- LANGUAGE-SELECTOR-START -->

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · **简体中文**

<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - 每个 AI Agent 的共享智脑

**一个本地引擎，在每个会话中，给每个机器上的 AI 编码工具一个内存、同一个防护栏和同一个上下文。**

</div>

---

EGC 是 AI 编码工具的本地第一个运行时间。安装一次，Cursor, Claude Codex, Codex, Copilot, 艾德和它支持的20个AI 编码工具的其余部分共享您项目的一个加密记忆。 每个命令前面的一个安全层，一个能使噪音输出远离模型的滤镜。 和一辆实时客车，让您打开的会话能够相互看到。原生支持 Claude、GPT-4o、Gemini、DeepSeek、Mistral、Groq、Cohere 和 Vertex AI，还可通过 OpenRouter 接入 Qwen3、Llama 4 等更多模型。

没有你的机器留下任何东西。内存生活在"~/.egc"中，使用AES-256-GCM加密，每个项目和分支保存，永远不承诺git。

---

## 安装

```bash
npm install -g @egchq/egc && egc install
```

这就是整个引擎。 `egc install` 检测到您拥有的工具，在其中每个工具中注册两个本地 MCP 服务器。 写下每个代理读取的内存协议，并设置令牌碎纸器。它提出了一个问题，您是否也想要可选的提示库，默认是否。

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="One command installs EGC across 20 AI coding tools" width="800" />
</div>

[完整安装指南](../../docs/installation.md)

---

## 工程：EGC 如何工作

ETC是一个大脑，有四个系。每个人都从第一次安装开始，在每个支持的工具上运行，没有任何命令可以学习。

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### 内存：每个代理人都知道什么

决定、会话背景、工作记忆和学到的教训在您工作时被抓取，并且可以在任何其他终端、IDE或您打开的代理中使用。你用任何语言说话都很自然：“保存本届会议”，“我们对自己做出什么决定？” “记住这个决定”。环境产品总分类理解意图，储存或回顾上下文情况。没有命令进行内存。

### Session Mesh: your open sessions see each Other

两个光标标签、一个Claude Code 终端和一个抗重力会话共用一个实时客车。他们宣布他们正在进行的工作，声称他们所编辑的档案， 携手合作，一旦事件降临，平行的会议合作而不是碰撞。

### 守卫者：每个命令前面的安全图层

守卫者在运行前验证命令，将冒险写入，并且在后台不需要任何动作的情况下保持上下文不会溢出。覆盖面取决于每个工具自己的钩子支持。[安全评估](../../docs/security/SECURITY-ASSESSMENT.md#known-limitations)记录例外情况。

### 令牌十字架：噪音永远不会达到模型

Shell 输出到模型之前，令牌压缩机日志，测试垃圾邮件， 安装噪音和巨型JSON，最多可达90%，同时保持每个错误和警告。问“我保存多少？”任何语言，答案都直接来自您的本地分类帐。

---

## 快速上手

没有第二步。打开任意一款 AI 工具，直接用任何语言对它说：“你好”、“继续刚才的内容”或“记住这个决定”即可。会话连接、内存加载以及每个打开的标签已经知道其他人在做什么。

一个包含代理活动、令牌和成本的实时仪表板在安装后立即开始。喜欢显式控制吗？所有命令都记录在[安装指南](../../docs/installation.md)中，不过你可能永远都不需要手动输入它们。

---

## 提示库(可选)

与引擎分开，默认情况下关闭EGC 也会投放一个书库，书库来自真正的工程会议：您可以访问61个代理人。 • 232种技能和77种命令，加上109条规则。专家自行审查您的代码，为每种语言和情况提供最佳做法指南。 运行整个任务序列的快捷方式，以及保持代码一致性的风格规则。将其添加到每个检测到的工具中，使用 `egc 安装 --mitt-library`，或使用 `egc 安装 --target <tool> --profile full`的工具。跳过它，引擎也完全一样工作。

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · **简体中文**

---

## 支持 EGC

EGC 是一个由社区成员独立开发，公开维护的开源免费项目。引擎是 Apache-2。 并且免费：如果EGC 提供了付费， 它将是一个团队图层，它将永远不会是您机器上的内存。

- **[官网](https://fmarzochi.github.io/EGCSite)**：包含完整文档、功能概览与在线演示
- **[Vision](../../docs/VISION.md)**：EGC 去哪里，什么是免费的
- **[加入 Discord](https://discord.gg/TxppsGb52)**：在这里提问并分享您的反馈意见
- **[在 GitHub 上赞助](https://github.com/sponsors/Fmarzochi)**：金额不限，每一份支持都很重要
- **[通过 PayPal 捐赠](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**：无需 GitHub 账号
- **点个 Star 关注**：让更多开发者发现此项目
- **[参与贡献](../../.github/CONTRIBUTING.md)**：开发 Agent、技能、命令、修复 Bug 以及完善文档
- **分享**：如果 EGC 改变了你的工作方式，欢迎向他人推荐

### 赞助者

社区支持是维持本项目生命力与独立性的基石。

#### 工具合作伙伴

与 EGC 原生集成的 AI 编程工具。合作伙伴的 Logo 将展示在所有项目的 README 文档和 EGCSite 官网上。

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### 年度赞助者 · _虚位以待，期待首个年度赞助_

---

#### 支持者

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a> <a href="https://github.com/jackmcwin"><img src="https://avatars.githubusercontent.com/u/135963880?v=4" width="52" height="52" alt="@jackmcwin" title="@jackmcwin, Chinese Simplified translation" /></a>

#### 月度赞助者 · _虚位以待_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp; <a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
