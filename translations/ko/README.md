<!-- LANGUAGE-SELECTOR-START -->
🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Español](../es/README.md) · [हिन्दी](../hi/README.md) · [日本語](../ja/README.md) · **한국어** · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC)

<div align="center">

# EGC - 확장된 전역 컨텍스트(Extended Global Context)

**AI 에이전트가 더 이상 처음부터 다시 시작하지 않습니다.**

*설정도, 명령어도 필요 없습니다. 작업만 하세요, 기억은 EGC가 합니다.*

</div>

---

EGC는 사용하는 모든 AI 코딩 도구에 지속적으로 유지되는 메모리를 제공하는 로컬 런타임입니다. 각 세션이 끝나면 AI는 작업을 통해 학습한 내용을 저장합니다. 여기에는 내린 결정, 실패한 시도, 사용자의 선호도, 그리고 다음에 이어서 진행할 작업이 포함됩니다. 다음 세션이 시작되면 AI는 이전 작업 상태를 아무 요청 없이 자동으로 불러옵니다. 어떤 언어로든 "계속하자" 또는 "어디까지 했지?"라고 말하면 AI가 무엇을 해야 할지 이미 알고 있습니다. 한 번 설치하면 Claude Code, Cursor, Gemini CLI, Windsurf, Zed, Warp, VS Code(GitHub Copilot 포함) 등 다양한 도구(총 19개)에서 사용할 수 있습니다. Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere, Vertex AI를 네이티브로 지원하며, Qwen3, Llama 4 등은 OpenRouter를 통해 지원합니다.

---

## 당신의 AI는 이미 알고 있습니다

2주 동안 손대지 않았던 프로젝트를 Claude Code에서 열고 아무것도 입력하지 않습니다.

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

이것은 지난 대화의 캐시가 아닙니다. EGC는 결정, 막다른 시도, 사용자의 선호도를 기억할 뿐만 아니라, 세션 내내 지켜보면서 코드베이스를 망가뜨릴 수 있는 명령어를 실행 전에 차단합니다. 아무것도 요청하지 않았습니다. 그냥 작업을 시작했을 뿐입니다.

<div align="center">
  <img src="../../assets/egc-terminal.gif" alt="EGC demo" width="700" />
</div>

---

## 설치

Windows, macOS, Linux 모두 설치 명령어는 같습니다.

```bash
npm install -g @egchq/egc && egc install
```

Windows에는 몇 가지 고유한 참고 사항이 있습니다 (PowerShell 버전, Antigravity CLI, 종료된 Gemini CLI 무료 등급). 예상치 못한 문제가 생기면 [Windows notes](../../docs/installation.md#windows-notes)를 확인하세요.

또는 전역으로 설치하지 않고 실행할 수 있습니다:

```bash
npx @egchq/egc install
```

**하나의 뇌, 여러 도구.** GitHub Copilot Chat 확장 프로그램을 설치하면 Copilot이 자동으로 스킬을 찾고, Claude Code나 Cursor에서 사용하던 것과 동일한 메모리가 그대로 나타납니다.

```bash
npm install -g @egchq/egc
egc install --target copilot
```

[전체 설치 가이드](../../docs/installation.md)

---

## EGC가 AI에 제공하는 기능

EGC는 모든 세션에서 항상 두 가지를 함께 실행합니다: 중요한 것을 기억하는 메모리, 그리고 위험한 명령어를 실행 전에 막는 안전 계층입니다. 설정 없이 바로 사용할 수 있습니다.

### 메모리: AI가 스스로 기억하는 것

명령어를 외울 필요가 없습니다. 어떤 언어로든 "어제 하던 것부터 이어서", "이 결정을 기억해", "지난번에는 뭐가 문제였지?"라고 말하면 AI가 정확히 무엇을 해야 할지 압니다. 작업은 당신의 몫, 기억은 EGC의 몫입니다.

**`egc-memory`**

| 도구 | 기능 |
|---|---|
| `get_state` | 세션을 여는 순간, AI가 이미 알고 있던 프로젝트 정보를 모두 불러옵니다 |
| `update_state` | 오늘 결정한 내용을 저장해 내일 아무도 맥락을 놓치지 않도록 합니다 |
| `store_decision` | 중요한 결정 하나를 영구히 기록합니다 |
| `query_history` | 과거의 결정을 일어난 순서대로 보여줍니다 |
| `search_history` | 날짜가 기억나지 않아도, 언젠가 내린 결정을 찾아줍니다 |
| `working_memory_set` / `_get` / `_list` | 더 이상 필요 없어지면 스스로 사라지는 빠른 메모입니다 |
| `lesson_save` | 배운 것을 기록하며, 다시 확인되지 않으면 시간이 지날수록 약해집니다 |
| `lesson_recall` | 여전히 쓸모 있는 교훈을 다시 불러옵니다 |
| `lesson_reinforce` | 같은 패턴이 다시 확인되면 교훈의 신뢰도를 높입니다 |
| `detect_patterns` | 같은 오류나 명령어가 반복되는 것을 알아챕니다 |
| `compress_observations` | 원시 기록을 요약해 토큰을 낭비하지 않게 합니다 |
| `get_project_state` | 메모리가 제대로 작동하는지 확인합니다 |

프로젝트의 각 브랜치는 당신의 컴퓨터에서 암호화된 자기만의 메모리를 가집니다. 클라우드를 포함해 다른 누구도 접근할 수 없습니다. 기본값이 곧 프라이버시이며, 설정할 필요가 없습니다.

### 컨텍스트와 안전: 작업 중 지켜보는 것

**`egc-guardian`**

이 도구들은 백그라운드에서 자동으로 실행됩니다. 모든 셸 명령과 파일 쓰기 작업은 실행되기 전에 검사됩니다. 직접 호출할 필요는 없습니다.

| 도구 | 기능 |
|---|---|
| `validate_command` | 모든 명령어를 실행 전에 검사해, 문제를 일으킬 수 있는 것을 차단합니다 |
| `validate_write` | AI가 실수로 민감한 파일에 쓰지 못하도록 막습니다 |
| `reduce_context` | 큰 파일을 압축해 토큰 예산을 낭비하지 않게 합니다 |
| `orchestrate_task` | 어떤 도구가 있는지 몰라도, 요청마다 알맞은 도구를 골라줍니다 |
| `auto_learn` | 세션의 실수에서 배우고, 반복되지 않도록 기록해 둡니다 |

### 요청이 아닌 강제

AI의 기분에 좌우되지 않는 보안입니다: 모든 명령어는 실행 전에 반드시 EGC를 거칩니다. [harness 강제, 세션 의도 감지, 메모리 마이너에 대한 자세한 내용 →](../../docs/installation.md#enforcement)

### 하나의 메모리. 모든 도구에서.

**`egc watch`** 를 한 번만 실행하고 잊어버리세요. Cursor에서 컨텍스트를 바꾸면 Gemini CLI, Copilot, Windsurf, Zed 등 사용하는 모든 곳에 자동으로 반영됩니다. 수동 작업도, 오래된 상태도 남지 않습니다.

```
egc watch              # watch current project
egc watch /path/proj   # watch a specific project
egc watch --quiet      # suppress output
```

### Dashboard: 에이전트가 일하는 모습을 실시간으로

에이전트가 만들어내는 모든 도구 호출, 토큰, 비용을 브라우저에서 실시간으로 확인하세요. `egc init` 실행 후 자동으로 시작됩니다. [전체 가이드](../../docs/installation.md#dashboard)

---

## 프롬프트 라이브러리

보너스로, EGC는 63개의 agent, 230개의 skill, 77개의 command, 그리고 111개의 rule에 대한 접근도 함께 제공합니다: 스스로 코드를 검토하는 전문가들, 모든 언어와 상황에 맞는 모범 사례 가이드, 일련의 작업을 한 번에 실행하는 단축키, 그리고 코드 일관성을 지켜주는 스타일 규칙입니다. 모두 이론이 아니라 실제 엔지니어링 세션에서 작성되었습니다. 아무것도 사용하지 않아도 괜찮습니다: EGC의 영구 메모리는 그대로 똑같이 작동합니다.

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Español](../es/README.md) · [हिन्दी](../hi/README.md) · [日本語](../ja/README.md) · **한국어** · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md)

---

## EGC 후원하기

EGC는 한 명의 개발자가 만들고, 공개적으로 유지·관리되며, 무료로 제공됩니다.

- **[웹사이트](https://fmarzochi.github.io/EGCSite)**: 전체 문서, 기능 소개 및 라이브 데모
- **[Discord 참여하기](https://discord.gg/AtazrtxJ)**: 질문하고, 피드백을 공유하세요.
- **[GitHub에서 후원하기](https://github.com/sponsors/Fmarzochi)**: 금액에 상관없이 후원할 수 있습니다.
- **[PayPal로 후원하기](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: GitHub 계정이 없어도 후원할 수 있습니다.
- **저장소에 Star 남기기**: 다른 개발자들이 이 프로젝트를 더 쉽게 찾을 수 있도록 도와줍니다.
- **[기여하기](../../.github/CONTRIBUTING.md)**: 에이전트, 스킬, 명령어, 버그 수정 및 문서
- **공유하기**: EGC가 여러분의 작업 방식을 바꿔주었다면, 다른 사람에게도 알려주세요.

### 후원자

커뮤니티의 후원은 이 프로젝트가 지속적으로 발전하고 독립성을 유지하는 데 큰 힘이 됩니다.

#### EGC 파트너

EGC와 기본적으로 통합되는 AI 코딩 도구입니다. 파트너의 로고는 모든 README와 EGCSite에 게재됩니다.

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### 연간 후원자 · _첫 번째 연간 후원자가 되어 주세요._

---

#### 일반 후원자

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>
<a href="https://github.com/minus43"><img src="https://avatars.githubusercontent.com/u/58040485?v=4" width="52" height="52" alt="@minus43" title="@minus43, Korean translation" /></a>

#### 월간 후원자 · _첫 번째 월간 후원자가 되어 주세요_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
