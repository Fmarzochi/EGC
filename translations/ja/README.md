<!-- LANGUAGE-SELECTOR-START -->
🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · **日本語** · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [简体中文](../zh-CN/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - すべてのAIエージェントに同じ脳を

**すべてのAIエージェント、IDE、ターミナル、セッションが自動的に共有する永続メモリ。覚えるプロンプトなし。文脈の再構築なし。話すだけ。**

</div>

---

EGCは単なるメモリツールではありません。あらゆるAIが初日からプロジェクトにいたかのように働ける知能レイヤーです。Cursor、Copilot、Claude Code、Codex、Aider、そしてあらゆるターミナルエージェントで(合計20のAIコーディングツールに対応)。 Claude、GPT-4o、Gemini、DeepSeek、Mistral、Groq、Cohere、Vertex AIにネイティブ対応し、OpenRouter経由でQwen3やLlama 4などにも対応します。

会話のたびにプロジェクトの集合知が育ちます。すべてのエージェントがそれを受け継ぎ、セッションごとに賢くなります。

---

## インストール

```bash
npm install -g @egchq/egc && egc install
```

- **コンテキストの無駄を最大90%削減し、トークンコストを抑え、すべてのAIをセッション間で完全に同期させます。**
- **Guardian: 実行前にすべてのコマンドを検証し、危険な書き込みをブロックし、プロンプトインジェクションを検出。共有される脳には安全レイヤーが標準搭載。**
- **ワンコマンド、設定ゼロ: メモリはローカルに暗号化して保存され、gitにコミットされることはありません。**

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="EGC install" width="800" />
</div>

[インストールガイド全文](../../docs/installation.md)

---

## 脳の中身: EGCの仕組み

EGCはツールの一覧ではなく、複数の能力を持つひとつの脳です。覚え、理解し、守り、濾過し、調整します。あなたのマシン上のすべてのAIエージェントで。

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="Cursor to Claude Code shared memory" width="900" />
</div>

### コマンドを覚えない、自然に話すだけ

どの言語でも脳に話しかけてください。「このセッションを保存して」「認証について何を決めた?」「この決定を覚えて」。EGCは意図を理解し、文脈を保存し、マシン上の他のタブ・ターミナル・ツールで即座に呼び出します。ひとつの脳。すべてのエージェント。覚えるコマンドはゼロ。

### 永続するプロジェクトメモリ

EGCはすべてのAIエージェントに永続的な共有脳を与えます。決定、セッションの文脈、ワーキングメモリ、学習したパターンを捉え、開いたどのターミナル・IDE・エージェントでも即座に利用可能にします。セッション状態、プロジェクト履歴、蓄積された教訓がタブ・ツール・チームメイトの間をシームレスに流れます。手動同期なし、文脈の喪失なし。メモリはすべてマシンの `~/.egc` にAES-256-GCMで暗号化され、ブランチごとに保存され、リポジトリにコミットされることはありません。

### Guardian: 組み込みの安全ガードレール

脳のもう半分はバックグラウンドでガードレールを走らせます。コマンドを実行前に検証し、危険な書き込みを止め、溢れる前にコンテキストを圧縮し、エージェント間のマルチステップタスクを編成し、すべての修正から学びます。ツールをひとつも呼び出すことなく。コンテキストを軽く、行動を安全に、ワークフローを自律的に保つ見えないセーフティネットです。

### Token Crusher: 脳は覚える前にノイズを濾過する

脳は覚えるだけでなく、濾過します。シェル出力がモデルに届く前に、EGCのToken Crusherがgitログ、テストのノイズ、インストールのスパム、巨大なJSONを最大90%圧縮し、エラーと警告は必ず残します。「どれだけ節約できた?」とどの言語で聞いても、ローカルの記録からコストゼロで答えが返ってきます。セッションは安く、コンテキストは長持ち。

---

## プロンプトライブラリ

ボーナスとして、EGCは63のエージェント、230のスキル、77のコマンド、さらに111のルールへのアクセスを提供します。自らコードをレビューする専門家、あらゆる言語と状況のベストプラクティスガイド、一連のタスクをまとめて実行するショートカット、コードの一貫性を保つスタイルルール。すべて理論ではなく実際のエンジニアリングセッションから書かれています。使いたくない?問題ありません。EGCの永続メモリはまったく同じように機能します。

---

## クイックスタート

ステップ 2 はありません。お好きな AI ツールを開いて、ただ話しかけてください。「やあ」「続きをやろう」「この決定を覚えて」、どの言語でも構いません。セッションは自動でログインし、メモリは自動で読み込まれ、開いているすべてのタブが互いの動きをすでに知っています。Cursor のタブ 2 つ、Claude Code のターミナル、Antigravity のセッションが、同時に 1 つの生きたコンテキストを共有します。

エージェントの活動・トークン・コストを映すライブパネルは、インストール直後に自動で立ち上がります。手動で操作したい場合は、すべてのコマンドが[インストールガイド](../../docs/installation.md)に記載されています。おそらく一度も入力する必要はないでしょう。

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · **日本語** · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [简体中文](../zh-CN/README.md)

---

## EGCを支援する

EGCは1人の開発者によって作られ、オープンにメンテナンスされている無料のプロジェクトです。

- **[Website](https://fmarzochi.github.io/EGCSite)**: 完全なドキュメント、機能概要、ライブデモ
- **[Join the Discord](https://discord.gg/TxppsGb52)**: 質問やフィードバックの共有
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
