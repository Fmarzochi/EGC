<!-- LANGUAGE-SELECTOR-START -->
**언어:** English | [العربية](translations/ar/README.md) | [Español](translations/es/README.md) | [हिन्दी](translations/hi/README.md) | [Português (Brasil)](translations/pt/README.md) | [한국어](translations/ko/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![npm version](https://img.shields.io/npm/v/@egchq/egc?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@egchq/egc) [![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Discord](https://img.shields.io/discord/1513941515452416130?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/AtazrtxJ) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](.github/CONTRIBUTING.md) [![Stars](https://img.shields.io/github/stars/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/stargazers) [![Forks](https://img.shields.io/github/forks/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/network/members) [![Issues](https://img.shields.io/github/issues/Fmarzochi/EGC)](https://github.com/Fmarzochi/EGC/issues) [![Maintained](https://img.shields.io/badge/Maintained-yes-brightgreen)](https://github.com/Fmarzochi/EGC/commits/main) [![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC) [![Featured on Product Hunt](https://img.shields.io/badge/Product%20Hunt-featured-DA552F?logo=producthunt&logoColor=white)](https://www.producthunt.com/posts/egc)

<!-- CENTERED-LANGUAGE-SELECTOR-START -->
<div align="center">

**Language / اللغة / Idioma / भाषा / 언어**

[English](README.md) | [العربية](translations/ar/README.md) | [Español](translations/es/README.md) | [हिन्दी](translations/hi/README.md) | [Português (Brasil)](translations/pt/README.md) | [한국어](translations/ko/README.md)

</div>
<!-- CENTERED-LANGUAGE-SELECTOR-END -->

<div align="center">

# EGC - 확장된 전역 컨텍스트(Extended Global Context)

**AI 에이전트가 더 이상 처음부터 다시 시작하지 않습니다.**

*새로운 명령어를 익힐 필요가 없습니다. 작업에만 집중하세요. 나머지는 EGC가 알아서 처리합니다.*

</div>

---

EGC는 사용하는 모든 AI 코딩 도구에 지속적으로 유지되는 메모리를 제공하는 로컬 런타임입니다. 각 세션이 끝나면 AI는 작업을 통해 학습한 내용을 저장합니다. 여기에는 내린 결정, 실패한 시도, 사용자의 선호도, 그리고 다음에 이어서 진행할 작업이 포함됩니다. 다음 세션이 시작되면 AI는 이전 작업 상태를 자동으로 불러옵니다. 별도의 프롬프트를 입력할 필요가 없습니다. 어떤 언어로든 "계속하자" 또는 "어디까지 했지?"라고 말하면 AI가 무엇을 해야 할지 이미 알고 있습니다. 한 번 설치하면 Claude Code, Cursor, Gemini CLI, Windsurf 등 다양한 도구에서 사용할 수 있습니다. Claude, GPT-4o, Gemini는 물론 DeepSeek, Qwen3, Llama 4를 비롯한 OpenRouter 모델과도 함께 사용할 수 있습니다.

---

## 실제로 EGC를 사용하면 다음과 같습니다.

2주 동안 손대지 않았던 프로젝트를 Claude Code에서 열고 아무것도 입력하지 않습니다.:

```
State loaded from egc-memory via ~/.egc/state/Projects-MyApp.md

Context and preferences acknowledged (terse responses).

Ready to pick up the next items:
• Test full install on a clean machine
• Add GEMINI.md with session memory protocol
• Publish v1.0.1 fix to npm after clean install test passes
• Add mcp_server_count to audit.js

=== EGC Stack Briefing ===
Stack: typescript, javascript
Stack agents: typescript-reviewer, javascript-reviewer
Always use: code-reviewer
Skill: coding-standards (cyclomatic complexity) - apply to all code written this session
===
```

AI는 이미 무엇을 만들고 있었는지, 어떤 결정을 내렸는지, 무엇이 실패했는지, 그리고 어디까지 작업했는지를 모두 알고 있습니다. AI가 이를 알고 있는 이유는 EGC가 이전 세션이 끝날 때 작업 상태를 저장하고, 이번 세션이 시작되자 사용자의 요청 없이 자동으로 다시 불러왔기 때문입니다. 아무것도 입력하지 않았습니다. 그냥 작업을 시작했을 뿐입니다.

<div align="center">
  <img src="assets/egc-terminal.gif" alt="EGC demo" width="700" />
</div>

---

## 설치(전역으로)

```bash
npm install -g @egchq/egc && egc install
```

또는 전역으로 설치하지 않고 실행할 수 있습니다:

```bash
npx @egchq/egc install
```

[전체 설치 가이드](docs/installation.md)

---

## EGC가 AI에 제공하는 기능

EGC는 모든 세션에서 함께 동작하는 두 개의 MCP 서버를 기본으로 제공합니다.

### Memory - AI가 자동으로 사용하는 14개의 도구

명령어를 외울 필요가 없습니다. 이 표는 AI가 자동으로 읽기 때문에 직접 확인할 필요가 없습니다. 어떤 언어로든 자연스럽게 말하세요. "어제 하던 것부터 이어서", "이 결정을 기억해", "지난번에는 뭐가 문제였지?" - 그러면 AI가 적절한 도구를 자동으로 호출합니다. 그냥 작업만 하세요. 나머지는 EGC가 알아서 처리합니다.

**`egc-memory`**

| 도구 | 기능 |
|---|---|
| `get_state` | L세션 시작 시 프로젝트 메모리를 불러옵니다. |
| `update_state` | 결정 사항, 사용자 선호도 및 다음 작업을 저장합니다. |
| `store_decision` | 결정 사항 하나를 SQLite에 저장합니다. |
| `query_history` | 타임스탬프를 기준으로 이전 결정 사항을 반환합니다. |
| `search_history` | BM25 순위 알고리즘을 사용한 전문 검색을 합니다. |
| `working_memory_set` | TTL이 적용된 임시 컨텍스트를 저장합니다. |
| `working_memory_get` | 임시 키를 조회합니다. |
| `working_memory_list` | 현재 프로젝트의 활성 임시 항목을 모두 나열합니다. |
| `lesson_save` | 신뢰도 감소를 적용하여 세션 간 지식을 기록합니다. |
| `lesson_recall` | 신뢰도 임계값 이상인 활성 학습 내용을 가져옵니다. |
| `lesson_reinforce` | 동일한 패턴이 반복되면 해당 교훈의 신뢰도를 높입니다. |
| `detect_patterns` | 훅 이벤트에서 반복되는 명령어와 반복적으로 발생하는 오류를 찾아 보여줍니다. |
| `compress_observations` | 토큰 사용량을 줄이기 위해 원시 훅 데이터를 구조화된 요약으로 압축합니다. |
| `get_project_state` | 서버 상태 메타데이터와 저장소 엔진 상태를 반환합니다. |

상태 파일은 `~/.egc/state/<project-slug>.md`에 저장됩니다. 프로젝트마다 하나의 파일을 사용하며, 일반 Markdown 형식으로 사람이 읽을 수 있습니다.

### Context and Safety - 상황이 복잡해질 때를 위한 5개의 도구

**`egc-guardian`**

이 도구들은 백그라운드에서 자동으로 실행됩니다. 모든 셸 명령과 파일 쓰기 작업은 실행되기 전에 검사됩니다. 이 도구들을 직접 호출할 필요는 없습니다.

| 도구 | 기능 |
|---|---|
| `validate_command` | 실행 전에 프로젝트의 안전 규칙에 따라 셸 명령을 검사합니다. |
| `validate_write` | 안전하지 않은 파일 쓰기를 방지하기 위해 파일 쓰기 경로를 검증합니다. |
| `reduce_context` | 토큰 사용량을 줄이기 위해 파일 페이로드를 압축합니다. |
| `orchestrate_task` | 에이전트 및 스킬 컨텍스트를 기반으로 프롬프트를 라우팅하고 압축 지표를 반환합니다. |
| `auto_learn` | 세션의 실패 사례를 분석하여 활용 가능한 교훈을 프로젝트의 모든 AI 도구 설정 파일에 기록합니다. |

### Always in sync - 사용하는 모든 도구에서 항상 동기화됩니다.

**`egc watch`** - 한 번만 실행하면 사용하는 모든 도구가 항상 동기화된 상태를 유지합니다. Cursor에서 컨텍스트를 수정하면 Gemini CLI, Copilot, Windsurf를 비롯한 다른 모든 도구에도 자동으로 반영됩니다. 작업 상태가 업데이트되면 모든 도구의 설정 파일도 함께 업데이트됩니다. 수동 작업도, 오래된 작업 상태도 없습니다.

```
egc watch              # watch current project
egc watch /path/proj   # watch a specific project
egc watch --quiet      # suppress output
```

### Dashboard - 실시간 통합 관제

브라우저에서 AI 에이전트의 모든 도구 호출, 토큰 사용량, 그리고 비용을 실시간으로 확인하세요.  -- `egc init` 실행 후 자동으로 시작됩니다. [전체 가이드](docs/installation.md#dashboard)

---

## 프롬프트 라이브러리

**479개의 컴포넌트** 가 추가로 제공됩니다. 설치하면 실제 엔지니어링 세션을 바탕으로 작성된 에이전트 63개, 스킬 229개, 명령어 76개, 그리고 규칙 111개를 사용할 수 있습니다. 이 모든 것을 사용하지 않아도 EGC의 영구 메모리 기능은 그대로 사용할 수 있습니다.

---

## EGC 후원하기

EGC는 한 명의 개발자가 만들고, 공개적으로 유지·관리되며, 무료로 제공됩니다.

- **[웹사이트](https://fmarzochi.github.io/EGCSite)**: 전체 문서, 기능 소개 및 라이브 데모
- **[Discord 참여하기](https://discord.gg/AtazrtxJ)**: 질문하고, 피드백을 공유하세요.
- **[GitHub에서 후원하기](https://github.com/sponsors/Fmarzochi)**: 금액에 상관없이 후원할 수 있습니다.
- **[PayPal로 후원하기](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: GitHub 계정이 없어도 후원할 수 있습니다.
- **저장소에 Star 남기기**: 다른 개발자들이 이 프로젝트를 더 쉽게 찾을 수 있도록 도와줍니다.
- **[기여하기](.github/CONTRIBUTING.md)**: 에이전트, 스킬, 명령어, 버그 수정 및 문서
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

#### 월간 후원자 · _첫 번째 월간 후원자가 되어 주세요_

---

<div align="center">

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
