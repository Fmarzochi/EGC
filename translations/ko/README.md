<!-- LANGUAGE-SELECTOR-START -->
🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · **한국어** · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - 모든 AI 에이전트에게 같은 뇌를

**내 컴퓨터의 모든 AI 코딩 도구에 같은 메모리, 같은 가드레일, 같은 컨텍스트를 매 세션마다 주는 하나의 로컬 엔진.**

</div>

---

EGC는 AI 코딩 도구를 위한 로컬 우선 런타임입니다. 한 번 설치하면 Cursor, Claude Code, Codex, Copilot, Aider를 비롯해 지원하는 20개의 AI 코딩 도구 전부가 암호화된 프로젝트 메모리 하나, 모든 명령 앞에 서는 안전 레이어 하나, 시끄러운 출력을 모델에서 떼어 놓는 필터 하나, 그리고 열려 있는 세션들이 서로를 볼 수 있게 하는 라이브 버스 하나를 공유합니다. Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere, Vertex AI를 기본 지원하며, OpenRouter를 통해 Qwen3, Llama 4 등도 지원합니다.

아무것도 내 컴퓨터 밖으로 나가지 않습니다. 메모리는 `~/.egc`에 AES-256-GCM으로 암호화되어 프로젝트와 브랜치별로 보관되며, git에 커밋되지 않습니다.

---

## 설치

```bash
npm install -g @egchq/egc && egc install
```

이것이 엔진의 전부입니다. `egc install`은 설치된 도구를 감지하고, 각 도구에 두 개의 로컬 MCP 서버를 등록하고, 모든 에이전트가 읽는 메모리 프로토콜을 기록하고, Token Crusher를 설정합니다. 질문은 하나뿐입니다. 선택 사항인 프롬프트 라이브러리도 설치할지 묻고, 기본값은 아니요입니다.

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="One command installs EGC across 20 AI coding tools" width="800" />
</div>

[전체 설치 가이드](../../docs/installation.md)

---

## 엔진: EGC의 작동 방식

EGC는 네 가지 능력을 가진 하나의 뇌입니다. 각 능력은 첫 설치부터, 지원하는 모든 도구에서, 외울 명령 없이 켜져 있습니다.

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### 메모리: 한 에이전트가 배운 것을 모든 에이전트가 압니다

결정, 세션 컨텍스트, 워킹 메모리, 학습된 교훈은 작업하는 동안 담기고, 내가 여는 다른 어떤 터미널, IDE, 에이전트에서도 쓸 수 있습니다. 어떤 언어로든 자연스럽게 말하세요. "이 세션 저장해줘", "인증에 대해 뭘 결정했지?", "이 결정 기억해줘". EGC는 의도를 이해하고 컨텍스트를 저장하거나 불러옵니다. 외울 명령은 없습니다.

### 세션 메시: 열려 있는 세션들이 서로를 봅니다

Cursor 탭 두 개, Claude Code 터미널, Antigravity 세션이 하나의 라이브 버스를 공유합니다. 무엇을 작업 중인지 알리고, 편집하는 파일을 선점하고, 서로에게 일을 넘기고, 이벤트가 도착하는 순간 집어 듭니다. 그래서 병렬 세션은 충돌하는 대신 협력합니다.

### Guardian: 모든 명령 앞에 서는 안전 레이어

Guardian은 명령을 실행 전에 검증하고, 위험한 쓰기를 막고, 컨텍스트가 넘치지 않게 지킵니다. 백그라운드에서, 아무것도 호출하지 않아도 됩니다. 적용 범위는 각 도구의 훅 지원에 따라 다르며, 예외는 [보안 평가](../../docs/security/SECURITY-ASSESSMENT.md#known-limitations)에 기록되어 있습니다.

### Token Crusher: 소음은 모델에 닿지 않습니다

셸 출력이 모델에 도달하기 전에 Token Crusher가 git 로그, 테스트 스팸, 설치 소음, 거대한 JSON을 최대 90퍼센트까지 압축하며 모든 오류와 경고는 보존합니다. "얼마나 아꼈지?"라고 어떤 언어로든 물어보면 답은 로컬 장부에서 곧바로 돌아옵니다.

---

## 빠른 시작

2단계는 없습니다. 어떤 AI 도구든 열고 그냥 말하세요. "안녕", "이어서 하자", "이 결정 기억해줘", 어떤 언어든 좋습니다. 세션은 연결되고, 메모리는 로드되며, 열려 있는 모든 탭이 다른 탭이 무엇을 하는지 이미 알고 있습니다.

에이전트 활동, 토큰, 비용을 보여주는 라이브 대시보드는 설치 직후 시작됩니다. 직접 제어하고 싶다면 모든 명령이 [설치 가이드](../../docs/installation.md)에 문서화되어 있습니다. 아마 한 번도 입력할 일이 없을 겁니다.

---

## 프롬프트 라이브러리 (선택 사항)

엔진과 별개로, 기본은 꺼진 상태로, EGC는 실제 엔지니어링 세션에서 쓰인 라이브러리도 함께 제공합니다. 61개의 에이전트, 232개의 스킬, 77개의 명령, 그리고 109개의 규칙에 접근할 수 있습니다. 스스로 코드를 리뷰하는 전문가, 모든 언어와 상황을 위한 모범 사례 가이드, 작업 시퀀스를 통째로 실행하는 단축 명령, 코드를 일관되게 유지하는 스타일 규칙. 감지된 모든 도구에 추가하려면 `egc install --prompt-library`, 도구 하나에만 추가하려면 `egc install --target <tool> --profile full`을 쓰세요. 건너뛰어도 엔진은 똑같이 작동합니다.

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · **한국어** · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

---

## EGC 후원하기

EGC는 한 명의 개발자가 만들고, 공개적으로 유지·관리되며, 무료로 제공됩니다. 엔진은 Apache-2.0이며 계속 무료입니다. EGC가 언젠가 유료 기능을 내놓더라도 그것은 엔진 위에 얹는 팀용 레이어이지, 내 컴퓨터의 메모리가 유료가 되는 일은 없습니다.

- **[웹사이트](https://fmarzochi.github.io/EGCSite)**: 전체 문서, 기능 소개 및 라이브 데모
- **[비전](../../docs/VISION.md)**: EGC가 나아가는 방향과 계속 무료로 남는 것
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

#### 후원자들

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>

#### 월간 후원자 · _첫 번째가 되어 주세요_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
