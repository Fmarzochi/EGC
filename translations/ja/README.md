<!-- LANGUAGE-SELECTOR-START -->
🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · **日本語** · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - すべてのAIエージェントに同じ脳を

**あなたのマシン上のすべてのAIコーディングツールに、同じメモリ、同じガードレール、同じコンテキストを、すべてのセッションで与えるひとつのローカルエンジン。**

</div>

---

EGCはAIコーディングツールのためのローカルファーストなランタイムです。一度インストールすれば、Cursor、Claude Code、Codex、Copilot、Aider、そして対応する20のAIコーディングツールのすべてが、暗号化されたプロジェクトメモリ、すべてのコマンドの前に立つ安全レイヤー、ノイズの多い出力をモデルから遠ざけるフィルター、そして開いているセッション同士が互いを認識できるライブバスを共有します。Claude、GPT-4o、Gemini、DeepSeek、Mistral、Groq、Cohere、Vertex AIにネイティブ対応し、OpenRouter経由でQwen3、Llama 4などにも対応します。

何もあなたのマシンから出ていきません。メモリは `~/.egc` にAES-256-GCMで暗号化して保存され、プロジェクトとブランチごとに管理され、gitにコミットされることはありません。

---

## インストール

```bash
npm install -g @egchq/egc && egc install
```

これでエンジンのすべてです。`egc install` は手元のツールを検出し、それぞれに2つのローカルMCPサーバーを登録し、すべてのエージェントが読むメモリプロトコルを書き込み、Token Crusherをセットアップします。質問はひとつだけ、オプションのプロンプトライブラリも入れるかどうかで、デフォルトは「いいえ」です。

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="One command installs EGC across 20 AI coding tools" width="800" />
</div>

[インストールガイド全文](../../docs/installation.md)

---

## エンジン: EGCの仕組み

EGCは4つの能力を持つひとつの脳です。それぞれが最初のインストールの瞬間から、対応するすべてのツールで、覚えるコマンドなしに働きます。

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### メモリ: ひとつのエージェントが学んだことを、すべてのエージェントが知っている

決定、セッションのコンテキスト、ワーキングメモリ、学んだ教訓は作業しながら記録され、開いた他のどのターミナル、IDE、エージェントでも利用できます。どの言語でも自然に話しかけてください。「このセッションを保存して」「認証について何を決めた?」「この決定を覚えて」。EGCは意図を理解し、コンテキストを保存または呼び出します。覚えるコマンドはありません。

### セッションメッシュ: 開いているセッション同士が互いを見る

2つのCursorタブ、Claude Codeのターミナル、Antigravityのセッションが、ひとつのライブバスを共有します。それぞれが何に取り組んでいるかを知らせ、編集するファイルを確保し、仕事を互いに引き渡し、イベントが届いた瞬間に拾い上げます。並行するセッションは衝突するのではなく協力します。

### Guardian: すべてのコマンドの前に立つ安全レイヤー

Guardianはコマンドを実行前に検証し、危険な書き込みを止め、コンテキストが溢れないように保ちます。すべてバックグラウンドで、あなたが何も呼び出すことなく。カバー範囲は各ツールのフック対応に依存し、例外は[セキュリティ評価](../../docs/security/SECURITY-ASSESSMENT.md#known-limitations)に記録されています。

### Token Crusher: ノイズはモデルに届かない

シェル出力がモデルに届く前に、Token Crusherがgitログ、テストのスパム、インストールのノイズ、巨大なJSONを最大90パーセント圧縮し、すべてのエラーと警告は残します。「どれだけ節約できた?」とどの言語で聞いても、答えはローカルの記録からそのまま返ってきます。

---

## クイックスタート

ステップ2はありません。お好きなAIツールを開いて、ただ話しかけてください。「やあ」「続きをやろう」「この決定を覚えて」、どの言語でも構いません。セッションはつながり、メモリは読み込まれ、開いているすべてのタブが他のタブの動きをすでに知っています。

エージェントの活動、トークン、コストを映すライブダッシュボードは、インストール直後に起動します。明示的に操作したい場合は、すべてのコマンドが[インストールガイド](../../docs/installation.md)に記載されています。おそらく一度も入力する必要はないでしょう。

---

## プロンプトライブラリ (オプション)

エンジンとは別に、デフォルトではオフのまま、EGCは実際のエンジニアリングセッションから書かれたライブラリも同梱しています。61のエージェント、232のスキル、77のコマンド、さらに109のルールにアクセスできます。自らコードをレビューする専門家、あらゆる言語と状況のベストプラクティスガイド、一連のタスクをまとめて実行するショートカット、コードの一貫性を保つスタイルルール。検出されたすべてのツールに追加するなら `egc install --prompt-library`、ひとつのツールだけなら `egc install --target <tool> --profile full` です。使わなくても、エンジンはまったく同じように動きます。

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · **日本語** · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

---

## EGCを支援する

EGCは1人の開発者によって作られ、オープンにメンテナンスされている無料のプロジェクトです。エンジンはApache-2.0で、これからも無料です。EGCがいつか有料のものを提供するとしても、それはエンジンの上に載るチーム向けのレイヤーであり、あなたのマシン上のメモリが有料になることはありません。

- **[Website](https://fmarzochi.github.io/EGCSite)**: 完全なドキュメント、機能概要、ライブデモ
- **[Vision](../../docs/VISION.md)**: EGCが向かう先と、無料であり続けるもの
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

#### Monthly sponsors · _be the first_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
