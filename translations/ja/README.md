<!-- LANGUAGE-SELECTOR-START -->

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · **日本語** · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - すべてのAIエージェントに同じ脳を

**1つのローカルエンジンは、すべてのセッションにおいて、あなたのマシン上のすべてのAIコーディングツールに同じメモリ、同じガードレール、同じコンテキストを与えます。**

</div>

---

EGCは、AIコーディングツールのローカル初のランタイムです。一度インストールし、カーソル、クロードコード、コーデックス、コピロットをインストールします。 Aider および残りの 20 の AI コーディングツールは、プロジェクトの 1 つの暗号化されたメモリを共有します。 すべてのコマンドの前にある安全層モデルからノイズの出力を遠ざけるフィルターを ライブバスの1つでセッションが開かれています Claude、GPT-4o、Gemini、DeepSeek、Mistral、Groq、Coher、Vertex AI、加えてQwen3、Lama 4などのOpenRouterでネイティブに動作します。

あなたの機械には何も残っていない。メモリは AES-256-GCM で暗号化された `~/.egc` に保存され、プロジェクトやブランチごとに保存され、gitにコミットすることはありません。

---

## インストール

```bash
npm install -g @egchq/egc && egc install
```

それがエンジン全体です。 `egc install` はツールを検出し、それぞれに2つのローカルMCPサーバーを登録します。 すべてのエージェントが読み取るメモリプロトコルを書き込み、トークンクラッシャーを設定します。オプションのプロンプトライブラリを使用するかどうかは、一つの質問をします。デフォルトは no です。

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="One command installs EGC across 20 AI coding tools" width="800" />
</div>

[インストールガイド全文](../../docs/installation.md)

---

## 脳の中身: EGCの仕組み

EGCは4つの学部を持つ1つの脳です。それぞれが最初のインストールから、サポートされているすべてのツールで、学習するコマンドがありません。

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### メモリ: エージェントが学ぶこと、すべてのエージェントが知っていること

意思決定、セッションコンテキスト、作業メモリ、学習済みのレッスンは、作業中にキャプチャされ、他の端末、IDE、またはエージェントで使用できます。「このセッションを保存する」、「私たちは何を決めたのか?」、「この決定を覚えておく」、どの言語でも自然に話すことができます。 EGCは、意図を理解し、文脈を保存またはリコールします。暗記するコマンドはありません。

### セッションメッシュ:オープンセッションはお互いを見ることができます

2つのカーソルタブ、Claude Codeターミナル、抗重力セッションは1つのライブバスを共有しています。彼らは、彼らが作業しているものを発表し、彼らが編集したファイルを主張します。 お互いに手を取り合って着陸した瞬間の出来事を拾って 並行セッションは衝突する代わりに協力する

### Guardian: 組み込みの安全ガードレール

Guardianは、コマンドが実行される前にコマンドを検証し、ゲートが危険な書き込みを行い、バックグラウンドでコンテキストがオーバーフローしないようにします。カバー範囲は各ツールのフック対応に依存し、例外は[セキュリティ評価](../../docs/security/SECURITY-ASSESSMENT.md#known-limitations)に記録されています。

### トークンクラッシャー: ノイズはモデルに到達しない

シェル出力がモデルに到達する前に、Token Crusherはgit ログを圧縮し、テストスパムを実行します。 すべてのエラーと警告を維持しながら、最大90%のノイズと巨大なJSONをインストールします。任意の言語で「どのくらい保存しましたか?」と尋ねると、答えはあなたの地元の台帳からまっすぐに来ます。

---

## クイックスタート

ステップ２がない。 AIツールのいずれかを開き、「こんにちは」、「続けましょう」、「この決定を覚えておきましょう」、「どんな言語でも。セッション接続、メモリロード、およびすべての開いているタブは、他のタブが何を行っているかすでに知っています。

エージェントの活動・トークン・コストを映すライブパネルは、インストール直後に自動で立ち上がります。手動で操作したい場合は、すべてのコマンドが[インストールガイド](../../docs/installation.md)に記載されています。おそらく一度も入力する必要はないでしょう。明示的なコントロールを好みますか？ [installation guide](../../docs/installation.md)には、すべてのコマンドが記載されています。

---

## プロンプトライブラリ

エンジンとは別に、デフォルトではEGCは実際のエンジニアリングセッションから書かれたライブラリも出荷しています。61人のエージェントにアクセスできます。 232のスキルと77のコマンドに109のルールを加えましたあなたのコードを自分自身で確認するスペシャリスト、すべての言語と状況のためのベストプラクティスガイド 一連のタスクを実行するショートカットと、コードの一貫性を保つスタイルルールがあります。 `egc install --prompt-library` で検出されたすべてのツールに追加するか、 `egc install --target <tool> --profile full` で1つのツールに追加します。それをスキップすると、エンジンはまったく同じ動作します。

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · **日本語** · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

---

## EGCを支援する

EGCは1人の開発者によって作られ、オープンにメンテナンスされている無料のプロジェクトです。エンジンは Apache-2 です。 EGCが有料のサービスを提供する場合は、無料のままにしてください。 マシンのメモリではなくチーム・レイヤーの上にあります

- **[Website](https://fmarzochi.github.io/EGCSite)**: 完全なドキュメント、機能概要、ライブデモ
- **[Vision](../../docs/VISION.md)**: EGCが行っている場所、そして無料のままにする
- **[Join the Discord](https://discord.gg/FmXbgUmdmM)**: 質問やフィードバックの共有
- **[Sponsor on GitHub](https://github.com/sponsors/Fmarzochi)**: 金額はいくらでも
- **[Donate via PayPal](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: GitHubアカウントなしでも可能
- **Star the repository**: 他の開発者が見つけやすくなります
- **[Contribute](../../.github/CONTRIBUTING.md)**: エージェント、スキル、コマンド、バグ修正、ドキュメント
- **Share**: EGCによって働き方が変わったなら、誰かに伝えてください

### スポンサー情報

コミュニティからの支援が、このプロジェクトを生かし、独立した状態に保ちます。

#### ツールパートナー

EGCとネイティブに統合されたAIコーディングツール。 EGCとネイティブに統合するAIコーディングツールです。パートナーはすべてのREADMEとEGCSiteにロゴを掲載できます。

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### 年次スポンサー・_最初の年次スポンサーになってください。_

---

#### バッター

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a> <a href="https://github.com/VIUK-XV"><img src="https://avatars.githubusercontent.com/u/216173586?v=4" width="52" height="52" alt="@VIUK-XV" title="@VIUK-XV, Japanese translation" /></a>

#### 毎月のスポンサー・_最初のスポンサーになる_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp; <a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
