# third-party-analyzer アーキテクチャ設計（architecture.md）

> 本ドキュメントは実装の方針・設計をまとめたもの。
> 「何を集計するか／なぜ作るか」は [idea.md](./idea.md) を参照。

---

## 1. 設計の背骨

**「計測（トレース取得）は1回。分析は同じ artifacts に対して複数アングルで行い、
出力は複数フォーマットへ差し替え可能にする」**

3つの関心を疎結合に分離する:

```
  Capture ──► Artifacts ──► Analyzer(複数) ──► AnalysisResult ──► Reporter(複数)
  (計測)      (保存)        (分析・純粋)        (構造化データ)       (出力: json/md/…)
```

- **Capture**: Lighthouse 実行。副作用（ブラウザ起動・HTTP）を持つのはここと
  一部 Analyzer（GTM取得）だけに閉じ込める。
- **Artifacts**: ディスクに保存され、何度でも再分析できる中間生成物。
- **Analyzer**: `Artifacts` を入力に取り、構造化された結果を返す。原則は純粋関数。
  追加・削除が独立してできる（プラグイン的）。
- **Reporter**: `AnalysisResult` を受けてフォーマット出力。JSON を基本に、
  Markdown など後から足せる。

この分離により「トレースは取り直さず、分析だけ追加・再実行」「出力形式だけ追加」
がそれぞれ独立して可能になる。

---

## 2. ディレクトリ構成

```
third-party-analyzer/
├── src/
│   ├── capture/
│   │   ├── runLighthouse.ts      # Lighthouse 実行 + artifacts 抽出
│   │   ├── medianRun.ts          # 複数回実行→代表(中央値)トレース選定
│   │   └── store.ts              # artifacts の保存/読込（run ディレクトリ）
│   │
│   ├── core/                     # アナライザ横断の共通基盤
│   │   ├── types.ts              # Artifacts / AnalysisResult / 共通型
│   │   ├── trace/
│   │   │   ├── markers.ts        # navigationStart/FCP/LCP 等のマーカー抽出
│   │   │   ├── mainthread.ts     # メインスレッド処理のカテゴリ別集計
│   │   │   └── longtasks.ts      # Long Task 抽出
│   │   ├── network/
│   │   │   ├── requests.ts       # DevtoolsLog → 正規化リクエスト一覧
│   │   │   ├── timing.ts         # リクエストのフェーズ分解(DNS/Connect/TTFB/DL)
│   │   │   └── classify.ts       # ドメイン分類(1st/3rd party tag/CDN lib)
│   │   └── time.ts               # 時刻正規化・時間窓ユーティリティ
│   │
│   ├── analyzers/
│   │   ├── Analyzer.ts           # Analyzer インターフェース定義
│   │   ├── registry.ts           # 名前→Analyzer の登録/解決
│   │   ├── lcp/                  # Analyzer 1: LCP到達分析
│   │   ├── third-party/          # Analyzer 2: サードパーティタグ
│   │   ├── gtm/                  # Analyzer 3: GTM 詳細（HTTP取得あり）
│   │   └── images/               # Analyzer 4: 画像（将来）
│   │
│   ├── report/
│   │   ├── Reporter.ts           # Reporter インターフェース定義
│   │   ├── registry.ts           # 名前→Reporter の登録/解決
│   │   ├── json.ts               # JSON 出力（基本）
│   │   └── markdown.ts           # Markdown 出力（後追加）
│   │
│   ├── ablate.ts                 # タグ無効化実験（capture×2 → 差分）
│   ├── cli.ts                    # CLI エントリ
│   └── index.ts                  # ライブラリAPI エクスポート
│
├── idea.md
├── architecture.md
└── package.json
```

---

## 3. データモデル（core/types.ts）

### 3.1 Artifacts（Capture の成果物）

```ts
interface Artifacts {
  meta: {
    url: string
    device: 'mobile' | 'desktop'
    throttling: object          // 計測条件（サイト間で揃える）
    capturedAt: string          // ISO 時刻（取得時刻を記録）
    lighthouseVersion: string
    runIndex?: number           // 複数回実行時の採用 run
  }
  trace: TraceEvent[]           // Chrome trace events（artifacts.Trace）
  devtoolsLog: DevtoolsLogEntry[] // CDP ログ（artifacts.DevtoolsLog）
  lhr: object                   // Lighthouse Result（audits 参照用）
}
```

ディスク上は 1 run = 1 ディレクトリ:

```
runs/<label>/
  meta.json
  trace.json
  devtoolslog.json
  lhr.json
```

### 3.2 派生モデル（core が trace/devtoolsLog から作る中間表現）

アナライザが生トレースを毎回触らずに済むよう、共通の正規化レイヤを置く。

```ts
interface Timeline {            // markers.ts
  navigationStart: number       // = 0 基準
  ttfb: number
  fcp: number
  lcp: number
  domContentLoaded: number
  load: number
}

interface NetworkRequest {      // requests.ts + timing.ts + classify.ts
  requestId: string
  url: string
  host: string
  resourceType: 'document'|'script'|'stylesheet'|'image'|'font'|'xhr'|'other'
  priority: 'VeryHigh'|'High'|'Medium'|'Low'|'VeryLow'
  startTime: number
  endTime: number
  encodedBytes: number
  timing: {                     // フェーズ分解
    queueing: number; dns: number; connect: number; tls: number
    waiting: number             // TTFB(送信〜最初のバイト)
    download: number            // 最初のバイト〜完了
  }
  // 分類（classify.ts）
  party: 'first' | 'third'
  thirdParty?: {
    isTag: boolean              // サードパーティタグか（CDNライブラリは false）
    entity?: string             // 例: "Google Analytics"（third-party-web 由来）
    category?: string           // analytics/ad/social/tag-manager/font/...
  }
  beforeLCP: boolean            // LCP前に開始したか（補助振り分け用）
}

interface MainThreadTask {      // mainthread.ts / longtasks.ts
  category: 'scripting'|'parsing'|'rendering'|'painting'|'gc'|'other'
  start: number; duration: number
  attributableUrl?: string
  isLongTask: boolean
}
```

> この `NetworkRequest` を最小単位として持ち、ドメイン/エンティティ/時間窓で
> `groupBy` 集計する（サードパーティのドメイン別ファイル数・転送量・時間・CPU や
> LCP前後の振り分けは、すべてこの一覧からのロールアップで出す）。

---

## 4. Analyzer の設計

### 4.1 インターフェース

```ts
interface AnalyzerContext {
  artifacts: Artifacts
  derived: {                    // core が用意する正規化済みデータ
    timeline: Timeline
    requests: NetworkRequest[]
    mainThread: MainThreadTask[]
  }
  fetch: typeof fetch           // 外部取得が必要なアナライザ用（GTM等）に注入
  logger: Logger
}

interface Analyzer<R = unknown> {
  name: string                  // "lcp" | "third-party" | "gtm" | ...
  /** 同じ Artifacts を入力に、構造化結果を返す（GTM以外は副作用なし） */
  analyze(ctx: AnalyzerContext): Promise<AnalysisResult<R>>
}

interface AnalysisResult<R = unknown> {
  analyzer: string
  schemaVersion: string         // 結果スキーマのバージョン（出力互換のため）
  url: string
  summary: Record<string, number | string>  // 上位サマリ（横並び比較用）
  data: R                       // アナライザ固有の詳細データ
  findings?: Finding[]          // 「★ここが問題」的な指摘（任意）
}

interface Finding {
  severity: 'info' | 'warn' | 'critical'
  message: string
  evidence?: Record<string, unknown>
}
```

### 4.2 各アナライザの責務

| Analyzer | 入力 | 副作用 | 主な出力 (`data`) |
|---|---|---|---|
| `lcp` | derived 全部 + lhr | なし | LCP4フェーズ・メインスレッド内訳・CRP長さと妨害・HTML/CSS・レイテンシー分解 |
| `third-party` | requests + mainThread | なし | リクエスト一覧 + ドメイン別/エンティティ別/カテゴリ別 + LCP前後振り分け |
| `gtm` | requests(GTMのURL検出) | **HTTP GET** | コンテナ一覧・容量・タグ/トリガー/変数数・タグ種別内訳・発火タイミング別 |
| `images` (将来) | requests(image) + trace | なし | 過大画像・非次世代・遅延読込漏れ 等 |

- 純粋アナライザ（lcp/third-party/images）は `ctx.fetch` を使わない。
- `gtm` だけが `ctx.fetch` で `googletagmanager.com/gtm.js?id=...` を取得し、
  本文（`var data = {"resource":{...}}`）を**防御的にパース**する。
  失敗時は部分結果＋`findings` に warn を残して続行。

### 4.3 third-party の分類ロジック（core/network/classify.ts）

優先順位で判定する:

1. **ファーストパーティ判定**: 計測URLの eTLD+1（+サブドメイン）と一致 → `first`。
2. **CDNライブラリ除外**: 自前のホスト除外リスト（jsDelivr/cdnjs/unpkg/
   code.jquery.com/`ajax.googleapis.com` 等）に一致 → `third` だが `isTag=false`。
3. **Google Fonts は明示的にタグ扱い**: `fonts.googleapis.com`/`fonts.gstatic.com`
   → `isTag=true`, category=`font`（idea.md の決定事項）。
4. 残りの third-party は `third-party-web` でエンティティ/カテゴリを解決し
   `isTag=true`。未知ドメインも `isTag=true`（category=unknown）。

> 除外リストと判定順は品質の要。テストを厚くし、誤分類は Reporter 側で
> 「除外したCDNライブラリ」一覧として透明化する。

---

## 5. Reporter の設計（複数フォーマット）

```ts
interface Reporter {
  name: string                  // "json" | "markdown" | ...
  extension: string             // "json" | "md"
  /** 1アナライザ分の結果を文字列化 */
  render(result: AnalysisResult): string
  /** 複数アナライザをまとめた1レポートにする場合（任意） */
  renderBundle?(results: AnalysisResult[]): string
}
```

- **json**（基本・最初に実装）: `AnalysisResult` をそのままシリアライズ。
  機械可読・他ツール連携・diff の土台。
- **markdown**（後追加）: `summary` を表に、`findings` を箇条書きに、詳細を節に。
  人が速い/遅いサイトを並べて読む用。
- 追加フォーマット（HTML、CSV 等）は Reporter を実装して `registry` に登録するだけ。
- `AnalysisResult` に `schemaVersion` を持たせ、Reporter は **データモデルだけに
  依存**（特定アナライザの内部実装に依存しない）。これで出力形式とアナライザを
  直交させる。

---

## 6. 実行フロー / CLI

**サイト間**の自動 diff（`compare`）は作らない。capture と analyze を分離し、
サイトごとに実行してレポートを人／LLM が並べて読む。
一方 **同一URLの ablation 差分**（`ablate`）は機械的な因果推定なのでツール側で計算する
（比較の主観が入らないため。この区別を守る）。

```
# 1) 計測（1回。複数runの中央値を代表として保存）
third-party-analyzer capture <url> --label fast  --device mobile --runs 5
third-party-analyzer capture <url> --label slow  --device mobile --runs 5

# 2) 分析（同じ artifacts に対して何度でも・複数アングル）
third-party-analyzer analyze lcp          ./runs/fast --format json,markdown
third-party-analyzer analyze third-party  ./runs/fast --format json
third-party-analyzer analyze gtm          ./runs/fast

# 3) まとめて
third-party-analyzer analyze all ./runs/slow --format markdown
```

内部処理:

```
capture(url, opts)
  └─ medianRun: runLighthouse × N → 代表 run 選定 → store.save(runDir)
       選定方式 = 「LCP が中央値に最も近い run を1本まるごと採用」。
       指標ごとの合成はしない（trace と数値の整合を保つため）。
       --runs 既定 = 3（1 で単発、急ぎ確認用）。偶数時は下側中央値を採用。

analyze(name, runDir, opts)
  ├─ store.load(runDir) → Artifacts
  ├─ core で derived(timeline/requests/mainThread) を構築（1回）
  ├─ registry.get(name).analyze(ctx) → AnalysisResult
  └─ opts.format ごとに registry(reporter).render() → ファイル出力

ablate(url, opts)                      # タグ無効化実験（--runs 既定 = 1）
  ├─ capture(url) → <out>/baseline/    # まず素の状態
  ├─ tagBlockTargets(baseline)         # classify で kind='tag' のホストを収集
  │    → patterns = *://host/* と *://*.<eTLD+1>/*
  ├─ capture(url, {blockedUrlPatterns}) → <out>/blocked/
  │    Lighthouse settings.blockedUrlPatterns → CDP Network.setBlockedURLs
  └─ 差分を <out>/ablation.json へ（両 run は通常の run ディレクトリなので再分析可）
```

`ablate` の設計上の割り切り（idea.md §11 に詳細）:

- 遮断は **空200ではなく失敗**（`ERR_BLOCKED_BY_CLIENT`）。忠実度より実装の軽さを取る。
- 既定は片側1回。ノイズ床の推定やページ破壊の検出はしない（**上限の参考値**と割り切る）。
- 遮断されたリクエストはトレース上 `statusCode: -1` の0バイト応答として残るため、
  集計側で成功リクエストのみを数える（`failedRequests` に分離）。
- `meta.blockedUrlPatterns` の有無でその run が ablation バリアントかを判別できる。

---

## 7. 技術スタック

- 言語: **TypeScript**（Node.js 20+, ESM）。
- 計測: `lighthouse`, `chrome-launcher`。
- トレース解析: まず自前パース（軽量）。堅牢化が必要なら
  `@paulirish/trace_engine` に寄せられるよう core 内で隔離。
- 分類: `third-party-web`。
- HTTP取得(GTM): `undici` もしくは Node 標準 `fetch`。
- CLI: 軽量パーサ（`citty`/`commander` 等）。
- テスト: `vitest`。保存済みの実トレースを fixture にしたテーブル駆動テスト。

---

## 8. 横断方針

- **スロットリング（最重要・正確性の根幹）**: `throttlingMethod: 'devtools'`（適用
  スロットル）で計測する。**`simulate`（Lantern）は使わない**。
  - 理由: `simulate` だと trace はほぼ無スロットルの高速マシンで記録され、
    ヘッドライン FCP/LCP だけが推定値になる。その結果「FCP/LCP までに起きたこと」を
    *速い端末上の狭い窓* で見ることになり、実体験の大半を見落とす
    （実測: crosset で観測LCP 1.3s vs 適用スロットルLCP 34s）。
  - `devtools` では trace 自体が実スロットル下の記録なので **reported == observed**。
    すべての窓集計（メインスレッド・ネットワーク・ブロッキング時間）が
    *一本の実タイムライン* 上で正確になる。
  - 代償: TTI/TBT/long-tasks 監査は超重量ページで算出失敗しうる
    （`NO_TTI_NETWORK_IDLE_PERIOD`）。→ **TBT と Long Tasks は trace から自前算出**。
- **trace 解釈は Lighthouse 実装に忠実に**（`core/lib/tracehouse` を参照実装とする）:
  - メインスレッド特定 = `TracingStartedInBrowser` のルートフレーム →
    `FrameCommittedInBrowser` で全 pid → 各 pid の `CrRendererMain`。
    「最も忙しい CrRendererMain」では広告 iframe を誤選択する。
  - タスクは `ph:'X'` と `ph:'B'/'E'` ペアの**両方**から構築。
  - self-time = 自身の duration − 子の duration 合計（親子木）。
  - グループ分類は `task-groups.js` の正確な名前マップ＋**親グループ継承**。
- **検証の三点一致（裏どり済み）**: メインスレッド集計は
  「自前 = `mainthread-work-breakdown` 監査 = `trace_processor` の独立SQL」が
  **ミリ秒単位で一致**することを確認（webdev/crosset）。Long Tasks も
  「自前 = trace_processor」で件数・合計・最大が一致。LCP 位相合算 = LCP。
- **時刻正規化**: すべて `navigationStart=0` に正規化してから扱う（core/time.ts）。
- **エラー方針**: データ起因（壊れたtrace/GTMパース失敗）と システム起因
  （ブラウザ起動・I/O・ネットワーク）を区別。データ起因は部分結果＋`findings`、
  システム起因は明示的に throw。
- **再現性**: 計測条件と取得時刻を `meta.json` に必ず記録（GTM取得は時点差が出るため）。
- **拡張点**: 新アナライザ＝`analyzers/<name>/` を足して registry 登録。
  新出力＝`report/<fmt>.ts` を足して registry 登録。コア改修不要。
- **検証(裏どり)**: `~/dev/study/perfetto`（google/perfetto クローン）の `docs/` で
  イベント定義を確認、`ui.perfetto.dev` で目視、`trace_processor` の SQL で
  自前集計を突き合わせる。Perfetto は検証用で本体依存にはしない。

---

## 9. 実装順（マイルストン案）

1. `core/types.ts` ＋ `capture`（runLighthouse / store）＋ `report/json.ts`。
2. `core/trace` `core/network`（derived 構築）。
3. `analyzers/lcp`（最重要・既存の集計項目を実装）。
4. `analyzers/third-party`（分類ロジック＋ドメイン/エンティティ集計＋LCP前後）。
5. `report/markdown.ts`（人が並べて読む用）。
6. `analyzers/gtm`（HTTP取得＋コンテナ解析）。
7. `analyzers/images`（将来）。
