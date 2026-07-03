<!-- LANGUAGE-SELECTOR-START -->
**言語:** [English](../../README.md) | [العربية](../ar/README.md) | [Español](../es/README.md) | [हिन्दी](../hi/README.md) | [한국어](../ko/README.md) | [Português (Brasil)](../pt/README.md) | [Русский](../ru/README.md) | **日本語**
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![npm version](https://img.shields.io/npm/v/@egchq/egc?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@egchq/egc) [![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Discord](https://img.shields.io/discord/1513941515452416130?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/AtazrtxJ) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](../../.github/CONTRIBUTING.md) [![Stars](https://img.shields.io/github/stars/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/stargazers) [![Forks](https://img.shields.io/github/forks/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/network/members) [![Issues](https://img.shields.io/github/issues/Fmarzochi/EGC)](https://github.com/Fmarzochi/EGC/issues) [![Maintained](https://img.shields.io/badge/Maintained-yes-brightgreen)](https://github.com/Fmarzochi/EGC/commits/main) [![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC) [![Featured on Product Hunt](https://img.shields.io/badge/Product%20Hunt-featured-DA552F?logo=producthunt&logoColor=white)](https://www.producthunt.com/posts/egc)

<!-- CENTERED-LANGUAGE-SELECTOR-START -->
<div align="center">

**Language / اللغة / Idioma / भाषा / 언어 / Язык / 言語**

[English](../../README.md) | [العربية](../ar/README.md) | [Español](../es/README.md) | [हिन्दी](../hi/README.md) | [한국어](../ko/README.md) | [Português (Brasil)](../pt/README.md) | [Русский](../ru/README.md) | **日本語**

</div>
<!-- CENTERED-LANGUAGE-SELECTOR-END -->

<div align="center">

# EGC - Extended Global Context

**あなたのAIエージェントは、もうゼロから始める必要がありません。**

*覚えるコマンドはありません。ただ作業するだけです。残りはEGCが処理します。*

</div>

---

EGCは、あなたが使うすべてのAIコーディングツールに永続メモリを提供するローカルランタイムです。各セッションの終わりに、AIは学んだことを保存します。下した決定、失敗したこと、あなたの好み、次に取りかかるべきことです。次のセッションの開始時には、その状態を自動で読み込みます。プロンプトは不要です。どの言語でも「続きをやろう」や「どこで止まった？」と言えば、AIはすでに何をすべきか分かっています。1回のインストールでClaude Code、Cursor、Gemini CLI、Windsurfなどをカバーします。Claude、GPT-4o、Geminiに加え、DeepSeek、Qwen3、Llama 4を含むOpenRouterモデルでも動作します。

---

## 実際のEGCの動き

2週間触っていなかったプロジェクトをClaude Codeで開きます。何も入力しなくても、次のようになります。

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

AIは、あなたが何を作っていたのか、どんな決定をしたのか、何が失敗したのか、そして正確にどこで止まったのかをすでに把握しています。EGCが前回のセッション終了時にその状態を保存し、今回の開始時に自動で読み戻したからです。あなたは何も入力していません。ただ作業を始めただけです。

<div align="center">
  <img src="../../assets/egc-terminal.gif" alt="EGC demo" width="700" />
</div>

---

## インストール

```bash
npm install -g @egchq/egc && egc install
```

グローバルにインストールせずに実行することもできます。

```bash
npx @egchq/egc install
```

[Full installation guide](docs/installation.md)

---

## EGCがAIに提供するもの

EGCには、毎回のセッションで連携して動く2つのMCPサーバーが含まれています。

### Memory - AIが自動で使う14個のツール

覚えるべきコマンドはありません。この表はAIが読むためのものなので、あなたが覚える必要はありません。どの言語でも、「昨日の続きから」「この決定を覚えて」「前回は何が壊れた？」のように自然に言えば、AIが適切なツールを呼び出します。あなたは作業するだけです。残りはEGCが処理します。

**`egc-memory`**

| Tool | What it does |
|---|---|
| `get_state` | セッション開始時にプロジェクトメモリを読み込みます |
| `update_state` | 決定、好み、次の手順を保存します |
| `store_decision` | 1つの決定をSQLiteに永続化します |
| `query_history` | タイムスタンプに基づいて過去の決定を返します |
| `search_history` | BM25ランキングによる全文検索を行います |
| `working_memory_set` | TTL付きの一時コンテキストを保存します |
| `working_memory_get` | 一時キーを読み取ります |
| `working_memory_list` | 現在のプロジェクトで有効な一時項目をすべて一覧表示します |
| `lesson_save` | 信頼度の減衰を伴うセッション横断の知識を記録します |
| `lesson_recall` | 信頼度しきい値を超える有効な教訓を取得します |
| `lesson_reinforce` | 同じパターンが繰り返されたときに教訓の信頼度を高めます |
| `detect_patterns` | フックイベントから繰り返されるコマンドやエラーを見つけます |
| `compress_observations` | トークン使用量を減らすため、生のフック観測を型付き要約に圧縮します |
| `get_project_state` | サーバーのヘルスメタデータとストレージエンジンの状態を返します |

状態ファイルは `~/.egc/state/<project-slug>.md` に保存されます。プロジェクトごとに1つのファイルで、プレーンなMarkdownなので人間にも読めます。

### Context and safety - 重い作業のための5つのツール

**`egc-guardian`**

これらのツールはバックグラウンドで自動的に実行されます。すべてのシェルコマンドとすべてのファイル書き込みは、実行前にチェックされます。あなたが直接呼び出す必要はありません。

| Tool | What it does |
|---|---|
| `validate_command` | 実行前にシェルコマンドをプロジェクトの安全ルールに照らしてチェックします |
| `validate_write` | 危険な書き込みを防ぐため、ファイル書き込み先を検証します |
| `reduce_context` | トークン予算を節約するため、ファイルペイロードを圧縮します |
| `orchestrate_task` | エージェント/スキルのコンテキストでプロンプトをルーティングし、圧縮メトリクスを返します |
| `auto_learn` | セッション中の失敗を掘り起こし、実行可能な教訓をプロジェクト内のすべてのAIツール設定ファイルへ書き込みます |

### 要求ではなく強制

検証は、AIが協力することを選ぶかどうかに依存しません。EGCはハーネスフックをインストールし、すべてのツール呼び出しで実行します。各シェルコマンドとファイル書き込みは実行前に検証され、破壊的なコマンド、認証情報のパス、force-pushは、複合コマンドの中にあってもブロックされます。すべてのプロンプトもコンポーネントカタログに照らしてルーティングされるため、適切なスキルとエージェントがコンテキストに注入されます。万一バリデータが存在しない場合、フックはフェイルオープンになり、自分のツールから締め出されることはありません。

プロバイダのAPIキー（`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`OPENAI_API_KEY`、または `OPENROUTER_API_KEY`）があれば、EGCは事前定義されたフレーズなしで、どの言語のセッション意図でも意味的に理解します。夜の作業を終えると言えば、AIが返答する前に状態が保存されます。翌朝に挨拶すれば、次の手順はすでにコンテキストに入っています。セッション終了時にはメモリマイナーが、そのセッションの決定と教訓をプロジェクト状態へ抽出します。キーがない場合、これらのLLM機能は正直に何もしませんが、ライフサイクルフックはそれでも状態が保存されることを保証します。

### 常に同期 - 使うすべてのツール間で

**`egc watch`** - 一度実行すれば、使っているすべてのツールが同期されます。Cursorでコンテキストを編集すると、Gemini CLI、Copilot、Windsurf、その他すべてに自動で反映されます。状態が更新されると、すべてのツール設定ファイルも更新されます。手動作業はなく、古い状態のままになることもありません。

```
egc watch              # watch current project
egc watch /path/proj   # watch a specific project
egc watch --quiet      # suppress output
```

### Dashboard - リアルタイムのMission Control

エージェントが生成するすべてのツール呼び出し、トークン、コストをブラウザでライブ表示できます。`egc init` の後に自動で起動します。[Full guide](docs/installation.md#dashboard)

---

## Prompt library

**479個のコンポーネント** がボーナスとして含まれています。インストールすると、実際のエンジニアリングセッションから書かれた63個のエージェント、229個のスキル、76個のコマンド、さらに111個のルールを利用できます。これらを完全に使わなくても、EGCは永続メモリを提供します。

---

## EGCを支援する

EGCは1人の開発者によって作られ、オープンにメンテナンスされている無料のプロジェクトです。

- **[Website](https://fmarzochi.github.io/EGCSite)**: 完全なドキュメント、機能概要、ライブデモ
- **[Join the Discord](https://discord.gg/AtazrtxJ)**: 質問やフィードバックの共有
- **[Sponsor on GitHub](https://github.com/sponsors/Fmarzochi)**: 金額はいくらでも
- **[Donate via PayPal](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: GitHubアカウントなしでも可能
- **Star the repository**: 他の開発者が見つけやすくなります
- **[Contribute](../../.github/CONTRIBUTING.md)**: エージェント、スキル、コマンド、バグ修正、ドキュメント
- **Share**: EGCによって働き方が変わったなら、誰かに伝えてください

### Sponsors

コミュニティからの支援が、このプロジェクトを生かし、独立した状態に保ちます。

#### Tool Partners

EGCとネイティブに統合するAIコーディングツールです。パートナーはすべてのREADMEとEGCSiteにロゴを掲載できます。

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### Annual Sponsors · _Be the first annual sponsor._

---

#### Backers

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>
<a href="https://github.com/VIUK-XV"><img src="https://avatars.githubusercontent.com/u/216173586?v=4" width="52" height="52" alt="@VIUK-XV" title="@VIUK-XV · Japanese translation" /></a>

#### Monthly sponsors · _be the first_

---

<div align="center">

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
