<!-- LANGUAGE-SELECTOR-START -->
🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Español](../es/README.md) · [हिन्दी](../hi/README.md) · **日本語** · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC)

<div align="center">

# EGC - Extended Global Context

**あなたのAIエージェントは、もうゼロから始める必要がありません。**

*設定不要。コマンド不要。あなたは作業するだけ、EGCが覚えています。*

</div>

---

EGCは、あなたが使うすべてのAIコーディングツールに永続メモリを提供するローカルランタイムです。各セッションの終わりに、AIは学んだことを保存します。下した決定、失敗したこと、あなたの好み、次に取りかかるべきことです。次のセッションの開始時には、その状態を自動で読み込みます。プロンプトは不要です。どの言語でも「続きをやろう」や「どこで止まった？」と言えば、AIはすでに何をすべきか分かっています。1回のインストールでClaude Code、Cursor、Gemini CLI、Windsurf、Zed、VS Code（GitHub Copilot付き）などをカバーします。Claude、GPT-4o、Geminiに加え、DeepSeek、Qwen3、Llama 4を含むOpenRouterモデルでも動作します。

---

## あなたのAIはもう知っている

2週間触っていなかったプロジェクトをClaude Codeで開きます。何も入力しなくても、次のようになります。

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

これは前回の会話のキャッシュではありません。EGCは決定、行き詰まった経緯、あなたの好みを覚えているだけでなく、セッションの間ずっと見張り続け、コードベースを壊しかねないコマンドを実行前にブロックします。あなたは何も頼んでいません。ただ作業を始めただけです。

<div align="center">
  <img src="../../assets/egc-terminal.gif" alt="EGC demo" width="700" />
</div>

---

## インストール

Windows、macOS、Linuxでインストールコマンドは同じです。

```bash
npm install -g @egchq/egc && egc install
```

Windows特有の注意点もあります（PowerShellのバージョン、Antigravity CLI、Gemini CLIの無料枠終了など）。何か想定外のことが起きたら[Windows notes](../../docs/installation.md#windows-notes)を確認してください。

グローバルにインストールせずに実行することもできます。

```bash
npx @egchq/egc install
```

**1つの頭脳、複数のツール。** GitHub Copilot Chat拡張機能をインストールしていれば、Copilotが自動でスキルを見つけ、Claude CodeやCursorですでに使っているメモリがそこにも反映されます。

```bash
npm install -g @egchq/egc
egc install --target copilot
```

[インストールガイド全文](../../docs/installation.md)

---

## EGCがAIに提供するもの

EGCは毎回のセッションで、常に2つのことを一緒に行います。大切なことを覚えておく記憶と、危険なコマンドを実行前に止める安全装置です。どちらも設定不要、最初から使えます。

### メモリ：あなたのAIが自分で覚えていること

覚えるべきコマンドは1つもありません。どの言語でも「昨日の続きから」「この決定を覚えて」「前回は何が壊れた？」と言えば、AIが正確に何をすべきか分かります。作業はあなたのもの、記憶はEGCのものです。

**`egc-memory`**

| Tool | What it does |
|---|---|
| `get_state` | セッションを開いた瞬間に、AIが知っていたプロジェクトの情報をすべて読み込みます |
| `update_state` | 今日決めたことを保存し、明日誰も話の続きを見失わないようにします |
| `store_decision` | 重要な決定を1つ、永久に記録します |
| `query_history` | 過去の決定を起きた順に表示します |
| `search_history` | いつ決まったか覚えていなくても、決定事項を見つけます |
| `working_memory_set` / `_get` / `_list` | 不要になったら自動で消える一時メモです |
| `lesson_save` | 学んだことを記録し、確認されないと時間とともに弱まります |
| `lesson_recall` | まだ役立つ教訓を呼び戻します |
| `lesson_reinforce` | 教訓が再び確認されたとき、その信頼度を高めます |
| `detect_patterns` | 同じエラーやコマンドが繰り返されていることに気づきます |
| `compress_observations` | 生の履歴を要約し、無駄にトークンを使わないようにします |
| `get_project_state` | メモリが正しく動作しているか確認します |

プロジェクトの各ブランチは、あなたのコンピュータ上で暗号化された、それぞれ専用のメモリを持ちます。クラウドを含め、他の誰もアクセスできません。設定不要で、最初からプライバシーが守られています。

### コンテキストと安全：作業中に見張っているもの

**`egc-guardian`**

これらのツールはバックグラウンドで自動的に実行されます。すべてのシェルコマンドとすべてのファイル書き込みは、実行前にチェックされます。あなたが直接呼び出す必要はありません。

| Tool | What it does |
|---|---|
| `validate_command` | すべてのコマンドを実行前にチェックし、問題を起こしかねないものをブロックします |
| `validate_write` | AIが誤って機密ファイルに書き込むのを防ぎます |
| `reduce_context` | 大きなファイルを圧縮し、トークン予算を無駄にしません |
| `orchestrate_task` | どのツールが存在するか知らなくても、リクエストごとに適切なツールを選びます |
| `auto_learn` | セッション中の失敗から学び、繰り返さないよう記録します |

### 要求ではなく強制

AIの機嫌に頼らない安全機能です。すべてのコマンドは実行前に必ずEGCを通過します。[ハーネスの仕組み、セッション意図の検出、メモリマイナーの詳細 →](../../docs/installation.md#enforcement)

### 1つのメモリ。すべてのツールで。

**`egc watch`** を一度実行すれば、あとは忘れてしまって構いません。Cursorでコンテキストを変更すると、Gemini CLI、Copilot、Windsurf、Zedなど、使っているすべてのツールに自動で反映されます。手動作業も、古い状態が残ることもありません。

```
egc watch              # watch current project
egc watch /path/proj   # watch a specific project
egc watch --quiet      # suppress output
```

### Dashboard：エージェントの動きをその場で見る

エージェントが生成するすべてのツール呼び出し、トークン、コストをブラウザでライブ表示できます。`egc init` の後に自動で起動します。[ガイド全文](../../docs/installation.md#dashboard)

---

## Prompt library

ボーナスとして、EGCは63個のagent、230個のskill、77個のcommand、さらに111個のruleへのアクセスも提供します。自分のコードを自動でレビューする専門家、あらゆる言語・状況向けのベストプラクティスガイド、一連のタスクをまとめて実行するショートカット、コードの一貫性を保つスタイルルールです。すべて理論ではなく、実際のエンジニアリングセッションから書かれています。使わなくても大丈夫です。EGCの永続メモリはそのまま同じように機能します。

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Español](../es/README.md) · [हिन्दी](../hi/README.md) · **日本語** · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md)

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
<a href="https://github.com/VIUK-XV"><img src="https://avatars.githubusercontent.com/u/216173586?v=4" width="52" height="52" alt="@VIUK-XV" title="@VIUK-XV, Japanese translation" /></a>

#### Monthly sponsors · _be the first_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
