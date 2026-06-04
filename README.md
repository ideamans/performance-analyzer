# performance-analyzer

競合（速いサイト）と自社（遅いサイト）を **並べて見比べ、「どこに無駄・妨害があるのか」を定量的に突きつける** ためのベンチマーク／反省ツール。

Lighthouse でトレースを **1回だけ取得** し、その同じ成果物に対して **複数の角度（アナライザ）** で分析します。出力は機械可読な JSON（フォーマットは追加可能な設計）。

> 設計の詳細は [architecture.md](./architecture.md)、集計項目の意図は [idea.md](./idea.md) を参照。

---

## 何ができるか

- **LCP 到達分析（`lcp`）** — FCP/LCP までに「何が起き／何が妨害し／どこが遅いか」
  - LCP 4フェーズ分解（TTFB / Load Delay / Load Time / Render Delay）
  - メインスレッド処理のカテゴリ別内訳（窓 `[0,FCP]` `[0,LCP]`、self-time）
  - Long Tasks・TBT（自前算出）
  - ネットワーク種別別・優先度別、レイテンシー律速 vs 帯域律速
  - HTML TTFB / CSS 到達時刻
  - **LCP 画像の通信タイムライン**（発見→接続→waiting→download とボトルネック判定）と**画像サイズ（実寸／表示／過大判定）**
  - **LCP 画像が画像中で何番目か**、描画パスを延ばす無関係リソースの特定
- **サードパーティタグ分析（`third-party`）** — 「タグ多すぎ？」の反省材料
  - 全体に占める割合（転送量 / 解凍後サイズ / CPU、**JS のみの内訳**も）
  - ドメイン別・ベンダー別・カテゴリ別の本数 / 転送量 / CPU / ブロッキング
  - **業界平均比**（third-party-web の平均実行時間と比較し「使い方が重い」を検出）
  - TBT 寄与・寄与率、第三者起因の Long Task 数
  - 冗長性検出（アナリティクス重複・GTM コンテナ複数・GA4 計測ID 複数）
  - レンダーブロッキングな第三者、遅延読込（ファサード）候補
  - **CDN ライブラリ（jsDelivr/cdnjs/jQuery/Google CDN 等）は「置換可能」としてタグから除外**し別枠表示。**Google Fonts はタグに含める**
- **GTM 詳細分析（`gtm`）** — 「GTM がなぜ肥大化しているか／何に使っているか」を**客観的な計数**で外観把握
  - コンテナを検出して **gtm.js を実取得（HTTP）し AST で正確に本文を復元**（`var data` をリテラル評価、失敗時のみ JSON フォールバック）
  - コンテナ数・タグ数・変数数、タグ種別内訳（GA4/カスタムHTML/広告変換/Custom Template…）
  - **ベンダー別タグ数**（設定内のドメイン＋テンプレート種別を third-party-web で機械的に帰属）— 「タグが多い主因はどの第三者か」に即答
  - **カスタムHTML タグ数 / 旧 Universal Analytics（計測停止）/ 停止中(paused)タグ** の見直し候補カウント
  - **発火タイミング**別タグ数（pageview / DOM Ready / window load / interaction / custom）
  - ※ 重さ（転送/CPU）の詳細は third-party 分析に委譲。GTM は「外観の客観分類」に徹する設計

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

### 2) 分析

```bash
node dist/cli.js analyze <angle> <runDir> [--format json] [--out <dir>] [--stdout]
```

- `<angle>`: `lcp` / `third-party` / `gtm`
- `--format`: 既定 `json`（カンマ区切りで複数指定可）
- `--out`: 出力先（既定は `<runDir>`）。`--stdout` で標準出力へ

```bash
# 例: 競合と自社をそれぞれ計測して並べて読む
node dist/cli.js capture "https://fast-competitor.example/" --out ./runs/fast
node dist/cli.js capture "https://our-slow-site.example/"  --out ./runs/slow

node dist/cli.js analyze lcp          ./runs/fast --stdout
node dist/cli.js analyze third-party  ./runs/slow --out ./reports
```

---

## 計測条件（スロットリング）

**適用（DevTools）スロットリングを使用**します（Lantern シミュレーションではありません）。
これにより記録されたトレース自体が実スロットル下の体験になり、**reported と observed の FCP/LCP が一致**、窓集計（メインスレッド・ネットワーク）が「実際に FCP/LCP までに起きたこと」を正確に反映します。

既定の条件（`src/capture/throttling.ts`）:

- **モバイル / CPU 4倍** スロットル
- **ネットワークは広帯域**（DL・UL とも ~100Mbps、追加レイテンシ ~0ms）
  - 帯域を意図的にボトルネックから外し、**CPU・発見遅延・サーバ応答** といった構造的問題を浮かび上がらせる狙い

> 絶対値はラボ値（やや悲観寄り）です。フィールド実測ではなく、**サイト間の構造比較**に用いてください。

---

## 設計

```
Capture ──► Artifacts ──► Analyzer(複数) ──► AnalysisResult ──► Reporter(複数)
 (計測)      (保存)        (分析・純粋)       (構造化データ)      (出力: json/…)
```

- **Capture**: Lighthouse 実行（performance のみ）。複数 run の LCP 中央値を採用
- **core/**: trace・devtoolsLog から正規化した派生モデル（Timeline / NetworkRequest / MainThreadTask / LongTask）を構築
- **analyzers/**: 同じ Artifacts を入力に取るプラグイン的モジュール（`lcp`, `third-party`）
- **report/**: フォーマット出力（現状 `json`）

```
src/
├── capture/     # Lighthouse 実行・中央値選定・保存・スロットリング
├── core/        # 派生モデル（trace/network/time）
├── analyzers/   # lcp / third-party（+ レジストリ）
├── report/      # json レポーター（+ レジストリ）
├── cli.ts
└── index.ts     # ライブラリ API
```

---

## 精度・裏取り

トレース解釈は **Lighthouse 本体（`core/lib/tracehouse`）を参照実装** として忠実に再現し、検証済みです。

- メインスレッド集計（self-time・カテゴリ分類）= `mainthread-work-breakdown` 監査 = Perfetto `trace_processor` の独立 SQL が **ミリ秒単位で一致**
- Long Tasks（自前抽出）= `trace_processor` と件数・合計・最大が一致
- サードパーティ CPU 帰属 = `third-party-summary` 監査と一致
- LCP 4フェーズ合算 = LCP

> 検証には [google/perfetto](https://github.com/google/perfetto) の `trace_processor` を裏取りに使用（本体の実行時依存ではありません）。

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
- [x] LCP 到達分析（`lcp`）
- [x] サードパーティタグ分析（`third-party`）
- [x] GTM 詳細分析（`gtm`、コンテナを HTTP 取得しタグ設定数・種別・発火タイミングを解析）
- [ ] 画像分析
- [ ] Markdown レポーター（2サイトを並べて読む用）

> `gtm` は分析時に `googletagmanager.com` から gtm.js を実取得します（取得時刻が計測時と差異が出る場合あり）。オフライン/CI では取得失敗を部分結果として扱います。
