# EGC - Extended Global Context for Trae

为 Trae IDE 带来 EGC - Extended Global Context (EGC) 工作流。此仓库提供自定义命令、智能体、技能和规则，可以通过单个命令安装到任何 Trae 项目中。

## 快速开始

### 本地安装（仅当前项目）

```bash
cd /path/to/your/project
egc install --target trae --profile full
```

这将在您的项目目录中创建 `.trae/`。

### 全局安装（所有项目）

```bash
cd ~
egc install --target trae --profile full
```

这将创建 `~/.trae/`，适用于所有 Trae 项目。`egc install --prompt-library` 会一次性为检测到的所有工具执行相同操作。

## 环境支持

- **默认**：使用 `.trae` 目录
- **CN 环境**：使用 `.trae-cn` 目录（通过 `TRAE_ENV=cn` 设置）

```bash
# 从项目根目录运行（全局安装时从 ~ 运行）
TRAE_ENV=cn egc install --target trae --profile full
```

**注意**：`TRAE_ENV` 在安装程序运行时读取；`egc doctor`、`egc repair` 和 `egc uninstall` 请使用相同的值。请始终从项目根目录（或 `~`）运行这些命令，不要在 `.trae` 目录内部运行。

## 卸载

安装程序会将写入的每个文件记录在安装状态（Trae 目录下的 `egc-install-state.json`）中，因此卸载只删除 EGC 安装的文件，不会询问确认：

```bash
# 从项目根目录运行（全局安装时从 ~ 运行）
egc uninstall --target trae

# CN 环境
TRAE_ENV=cn egc uninstall --target trae
```

`egc doctor` 会报告已安装文件的漂移，`egc repair` 会将其恢复。
## 包含的内容

### 命令

命令是通过 Trae 聊天中的 `/` 菜单调用的按需工作流。所有命令都直接复用自项目根目录的 `commands/` 文件夹。

### 智能体

智能体是具有特定工具配置的专门 AI 助手。所有智能体都直接复用自项目根目录的 `agents/` 文件夹。

### 技能

技能是通过聊天中的 `/` 菜单调用的按需工作流。所有技能都直接复用自项目的 `skills/` 文件夹。

### 规则

规则提供始终适用的规则和上下文，塑造智能体处理代码的方式。所有规则都直接复用自项目根目录的 `rules/` 文件夹。

## 使用方法

1. 在聊天中输入 `/` 以打开命令菜单
2. 选择一个命令或技能
3. 智能体将通过具体说明和检查清单指导您完成工作流

## 项目结构

```
.trae/ (或 .trae-cn/)
├── commands/           # 命令文件（复用自项目根目录）
├── agents/             # 智能体文件（复用自项目根目录）
├── skills/             # 技能文件（复用自 skills/）
├── rules/              # 规则文件（复用自项目根目录）
├── egc-install-state.json  # 安装状态
└── README.md           # 此文件
```

## 自定义

已安装的文件属于 EGC：`egc doctor` 会将对它们的修改报告为漂移，`egc repair` 会将其恢复。请将您自己的命令、智能体和规则放在旁边的独立文件中；安装程序永远不会触碰它没有写入的文件。

## 推荐的工作流

1. **从计划开始**：使用 `/plan` 命令分解复杂功能
2. **先写测试**：在实现之前调用 `/tdd` 命令
3. **审查您的代码**：编写代码后使用 `/code-review`
4. **检查安全性**：对于身份验证、API 端点或敏感数据处理，再次使用 `/code-review`
5. **修复构建错误**：如果有构建错误，使用 `/build-fix`

## 下一步

- 在 Trae 中打开您的项目
- 输入 `/` 以查看可用命令
- 享受 EGC 工作流！
