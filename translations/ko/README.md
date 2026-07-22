<!-- LANGUAGE-SELECTOR-START -->
🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · **한국어** · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [简体中文](../zh-CN/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - 모든 AI 에이전트에게 같은 뇌를

**모든 AI 에이전트, IDE, 터미널, 세션이 자동으로 공유하는 영속 메모리. 외울 프롬프트도, 다시 쌓을 컨텍스트도 없습니다. 그냥 말하세요.**

</div>

---

EGC는 또 하나의 메모리 도구가 아닙니다. 어떤 AI든 첫날부터 프로젝트에 있었던 것처럼 일하게 만드는 인텔리전스 레이어입니다. Cursor, Copilot, Claude Code, Codex, Aider 그리고 모든 터미널 에이전트에서(총 20개의 AI 코딩 도구 지원). Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere, Vertex AI를 기본 지원하며, OpenRouter를 통해 Qwen3, Llama 4 등도 지원합니다.

대화할 때마다 프로젝트의 집단 지성이 자랍니다. 모든 에이전트가 이를 물려받고, 세션마다 더 똑똑해집니다.

---

## 설치

```bash
npm install -g @egchq/egc && egc install
```

- **컨텍스트 낭비를 최대 90% 줄이고, 토큰 비용을 아끼고, 모든 AI를 세션 간에 완벽히 정렬시키세요.**
- **Guardian: 모든 명령을 실행 전에 검증하고, 위험한 쓰기를 차단하며, 프롬프트 인젝션을 탐지합니다. 공유되는 모든 뇌에는 안전 레이어가 기본 내장되어 있습니다.**
- **명령 하나, 설정 제로: 메모리는 내 컴퓨터에 로컬로 암호화되어 저장되며, git에 커밋되지 않습니다.**

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="EGC install" width="800" />
</div>

[전체 설치 가이드](../../docs/installation.md)

---

## 뇌의 내부: EGC의 작동 방식

EGC는 도구 목록이 아니라 여러 능력을 가진 하나의 뇌입니다. 기억하고, 이해하고, 보호하고, 거르고, 조율합니다. 내 컴퓨터의 모든 AI 에이전트에서.

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="Cursor to Claude Code shared memory" width="900" />
</div>

### 명령을 외우지 않습니다, 자연스럽게 말하세요

어떤 언어로든 뇌에게 말하세요. "이 세션 저장해줘", "인증에 대해 뭘 결정했지?", "이 결정 기억해줘". EGC는 의도를 이해하고 컨텍스트를 저장하며, 컴퓨터의 다른 탭·터미널·도구에서 즉시 불러옵니다. 하나의 뇌. 모든 에이전트. 외울 명령 제로.

### 영속하는 프로젝트 메모리

EGC는 모든 AI 에이전트에게 영속적인 공유 뇌를 줍니다. 결정, 세션 컨텍스트, 워킹 메모리, 학습된 패턴을 담아 열려 있는 어떤 터미널·IDE·에이전트에서든 즉시 쓸 수 있게 합니다. 세션 상태, 프로젝트 이력, 쌓인 교훈이 탭과 도구와 동료 사이를 매끄럽게 흐릅니다. 수동 동기화도, 컨텍스트 손실도 없습니다. 모든 메모리는 내 컴퓨터의 `~/.egc`에 AES-256-GCM으로 암호화되어 브랜치별로 보관되며, 저장소에 커밋되지 않습니다.

### Guardian: 내장된 안전 가드레일

뇌의 나머지 절반은 백그라운드에서 가드레일을 돌립니다. 실행 전에 명령을 검증하고, 위험한 쓰기를 막고, 넘치기 전에 컨텍스트를 압축하고, 에이전트 간 다단계 작업을 조율하고, 모든 교정에서 배웁니다. 도구를 단 하나도 호출할 필요 없이. 컨텍스트는 가볍게, 행동은 안전하게, 워크플로는 자율적으로 지키는 보이지 않는 안전망입니다.

### Token Crusher: 뇌는 기억하기 전에 소음을 거릅니다

뇌는 기억만 하지 않습니다. 거릅니다. 셸 출력이 모델에 도달하기 전에 EGC의 Token Crusher가 git 로그, 테스트 소음, 설치 스팸, 거대한 JSON을 최대 90% 압축하며 모든 오류와 경고는 보존합니다. "얼마나 아꼈지?"라고 어떤 언어로든 물어보세요. 로컬 장부에서 비용 없이 답이 돌아옵니다: 더 싼 세션, 더 오래가는 컨텍스트.

---

## 프롬프트 라이브러리

보너스로 EGC는 63개의 에이전트, 230개의 스킬, 77개의 명령, 그리고 111개의 규칙을 제공합니다. 스스로 코드를 리뷰하는 전문가, 모든 언어와 상황을 위한 모범 사례 가이드, 작업 시퀀스를 통째로 실행하는 단축 명령, 코드를 일관되게 유지하는 스타일 규칙. 전부 이론이 아닌 실제 엔지니어링 세션에서 나왔습니다. 안 쓰고 싶다면? 괜찮습니다. EGC의 영속 메모리는 똑같이 작동합니다.

---

## 빠른 시작

2단계는 없습니다. 어떤 AI 도구든 열고 그냥 말하세요. "안녕", "이어서 하자", "이 결정 기억해줘", 어떤 언어든 좋습니다. 세션은 스스로 로그인하고, 메모리는 스스로 로드되며, 열려 있는 모든 탭이 서로가 무엇을 하는지 이미 알고 있습니다. Cursor 탭 두 개, Claude Code 터미널, Antigravity 세션이 하나의 살아 있는 컨텍스트를 동시에 공유합니다.

에이전트의 활동, 토큰, 비용을 보여주는 라이브 패널은 설치 직후 저절로 시작됩니다. 수동 제어를 원하시나요? 모든 명령은 [설치 가이드](../../docs/installation.md)에 문서화되어 있습니다. 아마 한 번도 입력할 일이 없을 겁니다.

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · **한국어** · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [简体中文](../zh-CN/README.md)

---

## EGC 후원하기

EGC는 한 명의 개발자가 만들고, 공개적으로 유지·관리되며, 무료로 제공됩니다.

- **[웹사이트](https://fmarzochi.github.io/EGCSite)**: 전체 문서, 기능 소개 및 라이브 데모
- **[Discord 참여하기](https://discord.gg/TxppsGb52)**: 질문하고, 피드백을 공유하세요.
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
