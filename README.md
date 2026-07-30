# third-party-analyzer

**サードパーティタグがサイトのパフォーマンスをどれだけ食っているか** を定量化し、
**どのタグを削る／遅延させる／設定を直すか** の判断材料を出すツール。

- タグの本数・転送量・CPU・TBT を、**ベンダー別／カテゴリ別／業界平均比**で分解する
- タグの供給源である **GTM コンテナの構成**（何のタグが何個入っているか）を客観的に計数する
- **おまけ**として、LCP のうち「サードパーティ以外の要因」（TTFB・画像の発見遅延・
  画像サイズ・自社CSS/JSのレンダーブロック）を切り分ける
  → タグダイエットで直らない問題をタグのせいにしないため

想定する使い方:

1. **業種内ベンチマーク** — 例: ファッション通販10サイトを同条件で計測し、タグ量を横並び比較。
   「うちのタグ量は業界で普通か、それとも外れ値か」に答える
2. **1サイトのタグダイエット提案** — 「削除 / 遅延 / 設定見直し」の具体リストを、
   各項目に ms と KB を添えて出す
3. **調査・研究** — 多数サイトのタグ実装実態の調査

Lighthouse でトレースを **1回だけ取得** し、その同じ成果物に対して **複数の角度（アナライザ）**
で分析します。出力は機械可読な JSON（フォーマットは追加可能な設計）。

> 設計の詳細は [architecture.md](./architecture.md)、集計項目の意図は [idea.md](./idea.md) を参照。

---

## 何ができるか

### 1) サードパーティタグ分析（`third-party`）— 主分析

「タグ多すぎ？ 誰が重い？ 何を削れる？」に答える中心のアングル。

- 全体に占める割合（転送量 / 解凍後サイズ / CPU、**JS のみの内訳**も）
- ドメイン別・ベンダー別・カテゴリ別の本数 / 転送量 / CPU / ブロッキング
- **業界平均比**（third-party-web の平均実行時間と比較し「使い方が重い」を検出）
  → 削除ではなく **設定見直し** で直る候補が分かる
- TBT 寄与・寄与率、第三者起因の Long Task 数（タグの害はLCPよりTBTに出やすい）
- 冗長性検出（アナリティクス重複・GTM コンテナ複数・GA4 計測ID 複数）
  → **リスクゼロで削れる**最優先ダイエット項目
- レンダーブロッキングな第三者、遅延読込（ファサード）候補 → **遅延**バケット
- LCP 前に発生したタグ本数（`beforeLcpCount`）→ そのタグが LCP 経路にいるか
- **CDN ライブラリ（jsDelivr/cdnjs/jQuery/Google CDN 等）は「置換可能」としてタグから除外**し
  別枠表示。**Google Fonts はタグに含める**

### 2) GTM 詳細分析（`gtm`）— タグの供給源

「GTM がなぜ肥大化しているか／何に使っているか」を**客観的な計数**で外観把握。
ダイエットを実際に実行する場所なので、「重い」を「これを消す」に変換できる。

- コンテナを検出して **gtm.js を実取得（HTTP）し AST で正確に本文を復元**
  （`var data` をリテラル評価、失敗時のみ JSON フォールバック）
- コンテナ数・タグ数・変数数、タグ種別内訳（GA4/カスタムHTML/広告変換/Custom Template…）
- **タグの MECE 分類**（発火タグ / 制御タグ＝オートイベントリスナ等 / 停止中タグ、
  合計＝総タグ数）— 「実際に動くタグは何個か」を客観把握
- **ベンダー別タグ数**（設定内のドメイン＋テンプレート種別を third-party-web で機械的に帰属）
  — 「タグが多い主因はどの第三者か」に即答
- **カスタムHTML タグ数 / 旧 Universal Analytics（計測停止）/ 停止中(paused)タグ** の
  見直し候補カウント
- **発火タイミング**別タグ数（pageview / DOM Ready / window load / interaction / custom）
- ※ 重さ（転送/CPU）の詳細は third-party 分析に委譲。GTM は「何が入っているか」に徹する設計

### 3) LCP 到達分析（`lcp`）— おまけ（サードパーティ以外の要因）

タグ分析を誠実に保つためのアングル。LCP のうちタグでは説明できない部分を示す。

- LCP 4フェーズ分解（TTFB / Load Delay / Load Time / Render Delay）
- **LCP 4フェーズ × (CPU占有 / ネットワーク待ち / デッドタイム) の MECE 分解**
  （フェーズ長が違っても公平に比較可。デッドタイム＝CPUもネットワークも進捗しない真の空白
  ＝タイマー・スケジューリング停滞・**同意ゲート**などの人工的な待ち）
- メインスレッド処理のカテゴリ別内訳（窓 `[0,FCP]` `[0,LCP]`、self-time）
- Long Tasks・TBT（自前算出）— third-party の `tpLongTasks` と比べて自社/タグを切り分け
- ネットワーク種別別・優先度別、レイテンシー律速 vs 帯域律速
- HTML TTFB / CSS 到達時刻
- **LCP 画像の通信タイムライン**（発見→接続→waiting→download とボトルネック判定）と
  **画像サイズ（実寸／表示／過大判定）**
- **CRP リソースごとの取得分解**（HTML/レンダーブロッキングCSS・JS/LCP画像を、DNS/接続/TLS の
  レイテンシー・TTFB・ダウンロード・サイズ・新規接続有無・主因で分解）
- **LCP 画像が画像中で何番目か**、描画パスを延ばす無関係リソースの特定
  （ここにタグスクリプトが現れるのが「タグがLCPを害している」最も強い証拠）

---

## セットアップ

```bash
npm install
npm run build
```

Node.js 20+ / Chrome（`chrome-launcher` が Headless で起動）が必要です。

---

## 使い方

### 1) 計測（トレース取得）

```bash
# ビルド済み CLI
node dist/cli.js capture <URL> --out ./runs/<ラベル> [options]

# 開発時（tsx 直実行）
npm run dev -- capture <URL> --out ./runs/<ラベル>
```

| オプション | 説明 | 既定 |
|---|---|---|
| `--out <dir>` | 成果物の保存先（必須） | — |
| `--device <d>` | `mobile` / `desktop` | `mobile` |
| `--runs <n>` | 実行回数。LCP 中央値の run を1本採用 | `3` |
| `--log-level <l>` | `silent`/`error`/`warn`/`info`/`verbose` | `error` |

保存物（1 run = 1 ディレクトリ）: `meta.json` / `trace.json` / `devtoolslog.json` / `lhr.json`

> ベンチマーク用に複数サイトを計測するときは、**全サイトで `--device` と `--runs` を揃える**こと
> （1サイト = 1ディレクトリ）。タグは同意状態・地域・A/Bで出方が変わるため、1回の計測は
> 変動する母集団からの1標本。数字が不自然なら再計測する。

### 2) 分析

```bash
node dist/cli.js analyze <angle> <runDir> [--format json] [--out <dir>] [--stdout]
```

- `<angle>`: `third-party`（主）/ `gtm` / `lcp`（おまけ）
- `--format`: 既定 `json`（カンマ区切りで複数指定可）
- `--out`: 出力先（既定は `<runDir>`）。`--stdout` で標準出力へ

### ヘルプ / LLM 向けドキュメント（英語）
- `--help` / `-h`: 文脈別の短いヘルプ（`capture --help` / `analyze --help`）
- `--llm`: LLM 向けの詳細ドキュメント（**出力データの見方**、および
  **ベンチマークの回し方・ダイエット提案の書き方**を含む）。サブコマンド/アングル別に出力可
  ```bash
  third-party-analyzer --llm                       # 全体（概要＋全アングル）
  third-party-analyzer capture --llm
  third-party-analyzer analyze third-party --llm   # 主分析の出力フィールドの読み方
  third-party-analyzer analyze gtm --llm
  third-party-analyzer analyze lcp --llm
  ```

```bash
# 例A: 1サイトのタグダイエット提案
node dist/cli.js capture "https://our-site.example/" --out ./runs/ours
node dist/cli.js analyze third-party ./runs/ours --stdout
node dist/cli.js analyze gtm         ./runs/ours --stdout
node dist/cli.js analyze lcp         ./runs/ours --stdout   # タグで直らない分の切り分け

# 例B: 業種内ベンチマーク（例: ファッション通販10サイト）
for s in a b c d e f g h i j; do
  node dist/cli.js capture "https://$s.example/" --out ./runs/$s
  node dist/cli.js analyze third-party ./runs/$s --out ./reports/$s
  node dist/cli.js analyze gtm         ./runs/$s --out ./reports/$s
done
```

### 横並び比較で見る指標

自動 diff の `compare` コマンドは意図的に作っていません（各レポートを人／LLM が読み比べる）。
サイト間比較は次の指標で行うのが妥当です。

| 指標 | 意味 |
|---|---|
| `tagVendors` | 「タグ何本か」の実質的な本数（リクエスト数はピクセル同期で膨らむので不適） |
| `tpJsTransferKB` / `tpJsCpuShare` | 第三者 **JS** の重さ（画像はバイト比を歪めるので JS が素直） |
| `totalCpuMs` / `tpCpuShare` | 絶対値と割合はセットで読む（自社JSが重いと割合は下がる） |
| `tpTbtMs` | 操作応答性への害。タグの被害はここに出やすい |
| `heaviestVendorByCpu` | 最重量ベンダー＝ダイエットの第一候補 |
| `cpuVsAvg`（ベンダー別） | 業界平均比。>1 は「同じタグを他社より重く使っている」＝設定改善余地 |

---

## タグダイエット提案の組み立て方

`--llm` にも同じ内容が入っています（LLM に読ませる前提）。
「確度 × 削減量」の順に並べ、各項目に根拠フィールドを添える。

1. **削除（機能損失なし＝最優先）** — GTM の `pausedTags`、`legacyUa`（UA は計測停止済み）、
   アナリティクス重複・GTM コンテナ複数・GA4 ID 複数（`data.redundancy`）
2. **削除・統合（機能が重複）** — 同じ役割のベンダーが2つ（ヒートマップ2種、A/B2種など）。
   `byEntity` / `byCategory`
3. **遅延** — `facades[]`（チャット・動画・SNS埋め込み）、第三者の `renderBlocking[]`
4. **設定見直し（消さずに軽くする）** — `cpuVsAvg` が 1 を大きく超えるベンダー。
   記録レート・カスタムイベント過多・Custom HTML 化などが原因になりがち
5. **維持（削らないもの）** — 中核の計測は明示的に「残す」と書く。
   レポートを反タグ運動ではなくエンジニアリング計画にするため

最後に `lcp` と突き合わせる。タグが LCP 経路にいない（`beforeLcpCount` が小さい・
`renderBlocking` なし）なら、**ダイエットの効果は TBT/CPU/応答性であって LCP ではない**と
正しく書く。

---

## 計測条件（スロットリング）

**適用（DevTools）スロットリングを使用**します（Lantern シミュレーションではありません）。
これにより記録されたトレース自体が実スロットル下の体験になり、**reported と observed の
FCP/LCP が一致**、窓集計（メインスレッド・ネットワーク）が「実際に FCP/LCP までに起きたこと」
を正確に反映します。

既定の条件（`src/capture/throttling.ts`）:

- **モバイル / CPU 4倍** スロットル
- **ネットワークは広帯域**（DL・UL とも ~100Mbps、追加レイテンシ ~0ms）
  - 帯域を意図的にボトルネックから外し、**タグの CPU コスト**・発見遅延・サーバ応答といった
    構造的問題を浮かび上がらせる狙い（「回線が細いだけ」で覆い隠さない）

> 絶対値はラボ値（やや悲観寄り）です。フィールド実測ではなく、**サイト間の構造比較**に
> 用いてください。

---

## 配布 / 単独CLI（Bun）と Chrome 自動取得

### Chrome の自動取得
`capture` 実行時、Chrome を次の順で解決します（どの環境でも動くように）:
1. `CHROME_PATH` 環境変数、またはインストール済み Chrome を検出
2. 無ければ **Chrome-for-Testing を自動ダウンロード**
   （`@puppeteer/browsers`、`~/.cache/third-party-analyzer/browsers` にキャッシュ）

→ 「バイナリ/パッケージを入れて実行 → 必要なら Chrome が自動DL → Lighthouse 実行」が成立します。

### Bun での実行・単一バイナリ化
- **Bun でそのまま実行可能**（検証済み）: `bun src/cli.ts capture <URL> --out <dir>` /
  `bun src/cli.ts analyze <angle> <dir>`
- **`analyze` は単一バイナリ化できます**（純JS）:
  ```bash
  npm run build:binary      # bun build --compile → dist/third-party-analyzer
  ./dist/third-party-analyzer analyze third-party ./runs/ours --stdout
  ```
  third-party / GTM / LCP 解析は Chrome 不要で、保存済み artifacts に対しどこでも動きます。
- **`capture` は単一バイナリでは未対応**: Lighthouse がロケール等の実行時アセットを
  ファイルから読むため、`bun build --compile` の自己完結バイナリでは動きません
  （その旨を明示エラーで案内）。`capture` は **`bun`/`node` で依存込み実行**してください
  （Chrome 自動DL はそのまま機能します）。

> まとめ: 解析は「単一バイナリ or Bun/Node」、計測は「Bun/Node（+自動Chrome）」。

### CI / リリース（GitHub Actions）
- **test**（`main`/`develop` への push・PR）: 型チェック・vitest・ビルド＋単一バイナリのコンパイルスモーク
- **release**（`v*` タグ push）: **GoReleaser のネイティブ `bun` ビルダー**で
  5ターゲット（linux/darwin × amd64/arm64、windows x64）を `bun build --compile` し、
  アーカイブ・チェックサム・GitHub Release を自動生成（`.goreleaser.yaml`）
- リリースバイナリは `analyze` 用途。`capture` は Bun/Node 実行（Chrome 自動DL）を利用

## 設計

```
Capture ──► Artifacts ──► Analyzer(複数) ──► AnalysisResult ──► Reporter(複数)
 (計測)      (保存)        (分析・純粋)       (構造化データ)      (出力: json/…)
```

- **Capture**: Lighthouse 実行（performance のみ）。複数 run の LCP 中央値を採用
- **core/**: trace・devtoolsLog から正規化した派生モデル（Timeline / NetworkRequest /
  MainThreadTask / LongTask）を構築
- **analyzers/**: 同じ Artifacts を入力に取るプラグイン的モジュール
  （`third-party`, `gtm`, `lcp`）
- **report/**: フォーマット出力（現状 `json`）

```
src/
├── capture/     # Lighthouse 実行・中央値選定・保存・スロットリング
├── core/        # 派生モデル（trace/network/time）
├── analyzers/   # third-party / gtm / lcp（+ レジストリ）
├── report/      # json レポーター（+ レジストリ）
├── cli.ts
└── index.ts     # ライブラリ API
```

---

## 精度・裏取り

トレース解釈は **Lighthouse 本体（`core/lib/tracehouse`）を参照実装** として忠実に再現し、
検証済みです。

- サードパーティ CPU 帰属 = `third-party-summary` 監査と一致
- メインスレッド集計（self-time・カテゴリ分類）= `mainthread-work-breakdown` 監査 =
  Perfetto `trace_processor` の独立 SQL が **ミリ秒単位で一致**
- Long Tasks（自前抽出）= `trace_processor` と件数・合計・最大が一致
- LCP 4フェーズ合算 = LCP

> 検証には [google/perfetto](https://github.com/google/perfetto) の `trace_processor` を
> 裏取りに使用（本体の実行時依存ではありません）。

---

## 開発

```bash
npm run dev        # tsx で CLI 実行（例: npm run dev -- capture <URL> --out ...）
npm run build      # TypeScript ビルド（dist/）
npm run typecheck  # 型チェックのみ
npm run test       # vitest
```

- TypeScript（ESM, NodeNext）、Prettier 準拠（シングルクォート・セミコロンなし・120桁）

---

## ロードマップ

- [x] Capture（複数 run → 中央値）
- [x] サードパーティタグ分析（`third-party`、主分析）
- [x] GTM 詳細分析（`gtm`、コンテナを HTTP 取得しタグ設定数・種別・発火タイミングを解析）
- [x] LCP 到達分析（`lcp`、サードパーティ以外の要因の切り分け）
- [ ] Markdown レポーター（1サイトのダイエット提案 / 複数サイトの横並び表）
- [ ] 複数 run ディレクトリの一括分析（ベンチマークセット向け）

> `gtm` は分析時に `googletagmanager.com` から gtm.js を実取得します
> （取得時刻が計測時と差異が出る場合あり）。オフライン/CI では取得失敗を部分結果として扱います。
