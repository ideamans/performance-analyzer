# third-party-analyzer 設計メモ（idea.md）

## 0. このツールの狙い（プロダクトの目的）

**サードパーティタグがサイトのパフォーマンスをどれだけ食っているかを定量化し、
「どのタグを削る／遅延させる／設定を直すか」の判断材料を出すツール。**

主題はサードパーティタグ分析。GTM 分析は「そのタグがどこから供給されているか」、
LCP 到達分析は **おまけ** で「タグでは説明できない要因」を切り分けるためにある
（タグダイエットで直らない問題をタグのせいにしないため）。

想定する使い方:

1. **業種内ベンチマーク** — 例: ファッション通販10サイトを同条件で計測し、タグ量を横並び比較。
   「うちのタグ量は業界で普通か、外れ値か」に答える
2. **1サイトのタグダイエット提案** — 「削除 / 遅延 / 設定見直し」の具体リストに ms と KB を添える
3. **調査・研究** — 多数サイトのタグ実装実態の調査

ありがちな気づきを定量的に突きつけることをゴールにする:

- 「自社はサードパーティタグが多すぎる。速い競合はこれだけ少ない」
- 「同じベンダーを他社より N 倍重く使っている（＝設定の問題）」
- 「自社の Google Tag Manager はタグ設定が盛りすぎ／死んだタグが残っている」
- （おまけ）「そもそも LCP は TTFB と画像の問題で、タグを削っても直らない」

→ ツールは各サイトに対して **同じ分析を実行し、レポートを並べて見比べられる** ようにする。
（※ 自動 diff の `compare` 機能は作らない。各サイトのレポートを人／LLM が見比べる。）

---

## 1. 全体アーキテクチャ（フレームワーク方針）

**「計測（トレース取得）は1回。分析は同じトレースに対して複数の角度で行う」**
という分離をフレームワークの背骨にする。

```
                          ┌─────────────────────────────┐
  URL ──► [Capture] ──►   │  成果物（artifacts）         │
        Lighthouse(1回)   │   - trace.json               │
                          │   - devtoolslog.json         │
                          │   - lhr.json                 │
                          │   - meta(url, device, etc.)  │
                          └──────────────┬──────────────┘
                                         │ （保存。何度でも再分析可能）
            ┌────────────────────────────┼────────────────────────────┐
            ▼                            ▼                            ▼
  [Analyzer 1(主): 3rdパーティタグ]  [Analyzer 2: GTM詳細]    [Analyzer 3(おまけ): LCP到達]
   分量・CPU消費・ベンダー内訳        コンテナ取得→設定解析     タグ以外の要因の切り分け
            │                            │                            │
            └──────────► 各 Analyzer が独立したレポートを出力 ◄────────┘
```

※ 章番号は歴史的経緯で「3. LCP到達分析 / 4. サードパーティタグ / 5. GTM」の順のまま
（実装済みの集計項目メモとして残す）。読む順序は **4 → 5 → 3** が主題に沿う。

ポイント:

- **Capture と Analyzer を疎結合に**。トレースさえあれば後からアナライザを足せる。
- アナライザは **同じ artifacts を入力に取る純粋関数的なモジュール** として実装。
- 一部のアナライザ（GTM・サードパーティ）は **追加で HTTP 取得** を行う
  （トレースには含まれない本文を取りに行く。後述）。
- 出力は機械可読（JSON）＋人間可読（Markdown/表）。サイトをまたいで並べて読む。

---

## 2. Capture（トレース取得）フェーズ

### 方針

- Node.js から Lighthouse をプログラマティックに実行（CLI ではなく API 利用）。
- `chrome-launcher` で Headless Chrome を起動。
- カテゴリは **performance のみ**。解析に必要な生データ（trace / devtoolslog）を保存。

### 実行設定（イメージ）

```js
import lighthouse from 'lighthouse'
import * as chromeLauncher from 'chrome-launcher'

const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new'] })

const result = await lighthouse(url, {
  port: chrome.port,
  onlyCategories: ['performance'],
  output: ['json'],
  // 生データの取得が肝
  // - result.artifacts.Trace        : Chrome trace events（メイン解析対象）
  // - result.artifacts.DevtoolsLog  : CDP のネットワーク/イベントログ
})
```

- `artifacts.Trace`（トレースイベント配列）と `artifacts.DevtoolsLog`（CDPログ）
  の両方を保存する。
  - **Trace**: メインスレッドの処理内訳、ペイント、LCP/FCP マーカー、フレーム。
  - **DevtoolsLog**: ネットワークの優先度・タイミング・サイズ・initiator が取りやすい。
- 計測条件を固定（device=mobile/desktop, CPU/Network throttling）。サイト間で揃える。
- 単発はブレるので複数回（例 3〜5回）→ 中央値の代表 trace を選ぶ。
- 保存物（サイトごと）: `trace.json` / `devtoolslog.json` / `lhr.json` / `meta.json`。

### Lighthouse の算出値も活用（自前解析の答え合わせ）

- `audits['largest-contentful-paint-element']`（LCP 要素・phase内訳）
- `audits['lcp-lazy-loaded']` / `audits['prioritize-lcp-image']`
- `audits['render-blocking-resources']`
- `audits['network-requests']` / `audits['network-rtt']` / `audits['network-server-latency']`
- `audits['mainthread-work-breakdown']` / `audits['bootup-time']`
- `audits['long-tasks']` / `audits['critical-request-chains']`
- `audits['third-party-summary']` / `audits['third-party-facades']`（★タグ分析の土台）
- `audits['metrics'].details.items[0]`（TTFB/FCP/LCP/TBT 等の数値）

---

## 3. Analyzer 1: LCP到達分析（何が起き／妨害し／遅いか）

「FCP まで」「LCP まで」の時間窓 `[0, FCP]` `[0, LCP]` を主軸に集計する。
（`[FCP, LCP]` 区間も差分要因の特定に有効。）

### 3.A タイムライン主要指標

| 項目 | 説明 |
|---|---|
| TTFB | 最初のドキュメント応答までの時間 |
| FCP / LCP | First / Largest Contentful Paint |
| FMP / First Paint | 参考 |
| DCL / Load | DOMContentLoaded / load |
| TBT | Total Blocking Time |
| LCP − FCP | FCP後にLCPまで何が起きたかの大きさ |

### 3.B メインスレッド処理内訳（時間窓ごと）

`[0, FCP]` `[0, LCP]` のそれぞれで処理カテゴリ別の合計時間と件数を集計:

| カテゴリ | 含むイベント例 | 集計値 |
|---|---|---|
| Scripting（JS実行） | EvaluateScript, FunctionCall, v8.compile | 合計ms / 件数 |
| Parsing（HTML/CSS解析） | ParseHTML, ParseAuthorStyleSheet | 合計ms |
| Rendering（スタイル/レイアウト） | RecalcStyles, Layout, UpdateLayoutTree | 合計ms |
| Painting（描画/画像デコード） | Paint, Composite, DecodeImage | 合計ms |
| GC | MinorGC, MajorGC | 合計ms |
| System/Other | その他 | 合計ms |
| **Idle（待機）** | メインスレッドが空いていた時間 | 合計ms |

- **Idle が大きい** → ネットワーク待ちがボトルネック。
- **Scripting が大きい** → JS実行がボトルネック。

### 3.C Long Tasks（50ms超）

- 時間窓内の Long Task の件数・合計・最長。
- 各 Long Task の主因（url/関数名）トップN。

### 3.D ネットワーク／リソース（時間窓ごと）

| 集計軸 | 内容 |
|---|---|
| リソース種別ごと | document / script / stylesheet / image / font / xhr-fetch / other |
| 件数・転送量・所要時間 | 種別ごと（encodedDataLength 合計など） |
| 総リクエスト数・総転送量 | FCP前 / LCP前 |
| 第三者比率 | サードパーティの本数・バイト・時間（→Analyzer2と連携） |
| 並列度 | 同時にいくつ走っていたか |

クリティカル項目: レンダーブロッキング本数・時間、クリティカルチェーン、
リソース優先度分布、発見の遅さ（特にLCP画像）。

### 3.D-2 通信ごとのレイテンシー分解（レイテンシー律速 vs 帯域律速）

1リクエストごとにタイミングを段階分解（DevtoolsLog の `timing` 等から算出）:

| フェーズ | 内容 | 律速の示唆 |
|---|---|---|
| Queueing / Stalled | キュー・接続枠待ち | 同時接続数・優先度 |
| DNS / Connect / TLS | 名前解決・接続・ハンドシェイク | RTT（レイテンシー） |
| **Waiting (TTFB)** | 送信〜最初のバイト | **サーバー処理＋RTT** |
| **Content Download** | 最初のバイト〜完了 | **転送量÷帯域** |

- 全体の **Waiting合計 vs Download合計** で「待ち律速 or 帯域律速」を切り分け。
- ドメインごとの接続コスト、RTT推定（`network-rtt`/`network-server-latency`）。
- Waiting/Download/サイズが大きい順のワーストN。

### 3.D-3 HTML / CSS のサイズと到達時間（FCPの土台）

| 項目 | 説明 |
|---|---|
| **HTML TTFB** | ドキュメントのサーバー応答時間（最重要） |
| HTML 転送量 / DL時間 / 取得完了時刻 | パース開始がいつ始まるか |
| CSS 合計サイズ / 本数 | レンダーブロッキングCSSの総量 |
| CSS が揃う時刻 | 全レンダーブロッキングCSSが揃った時刻（≒FCP可能時刻） |
| HTML+CSSが揃うまでの時間 | FCP の理論下限に近い |

### 3.E LCP 詳細分析

#### E-1 LCP のフェーズ分解（4区間）

| フェーズ | 定義 | 着目点 |
|---|---|---|
| TTFB | navigation→最初の応答 | サーバー応答 |
| Resource Load Delay | TTFB→LCPリソース取得開始 | 発見の遅さ（preload不足等） |
| Resource Load Time | 取得開始→取得完了 | 画像サイズ・回線・優先度 |
| Element Render Delay | 取得完了→描画 | メインスレッド占有 |

#### E-2 LCP 要素の素性

- 種別（画像 / テキスト / 背景画像 / video poster）。
- 画像なら URL・実寸・表示サイズ・フォーマット（次世代か）。

#### E-3 LCP 画像が「最優先で読まれているか」

| チェック | 取得元 | 良い状態 |
|---|---|---|
| `fetchpriority="high"` | trace priority / DevtoolsLog | high |
| ネットワーク priority | ResourceSendRequest.priority | High/VeryHigh |
| `<link rel=preload>` | DevtoolsLog / lhr | あり |
| `loading="lazy"` でない | lcp-lazy-loaded / trace | lazy でない |
| 発見順位・開始時刻 | リクエスト開始順 | 早い |
| 帯域競合 | 同時実行リソースの優先度 | 競合少 |
| デコード時間 | DecodeImage | 短い |

### 3.F レンダリングを妨げた要因

- FCP/LCP 直前に長く走っていた処理（JS / レンダーブロッキングCSS）。
- メインスレッドが LCP 画像のデコード/描画をいつ実行できたか（占有遅延）。

### 3.G クリティカルレンダリングパス（CRP）

**長さ** と **妨害** の両面で見る。

- **G-1 長さ**: チェーン深さ／最長パス時間／各段がレイテンシー待ちかDLか
  （`critical-request-chains` を基礎に）。
- **G-2 妨害**: クリティカルリソース（HTML/CSS/LCP画像）が、低優先度・不要な
  リソースのDL/処理に妨害されていないか。
  - 帯域の奪い合い（クリティカル取得中に並走した非必須転送量）。
  - 接続枠の占有による Stalled/Queueing。
  - 発見前の割り込み（先に送られた低優先度リソース数）。
  - 優先度の逆転。
  - 「妨害寄与度ランキング」上位N。

---

## 4. Analyzer 2: サードパーティタグ分析

「速いサイトはサードパーティタグが少ない／自社は多い」を突きつけるための集計。

### 4.1 「サードパーティタグ」の定義（重要）

外部ドメインから読み込まれるものすべてではない。**自社の管理下で中身を
自由に変更・置換できないもの** をサードパーティタグとする。

- **含める**: 解析（GA等）、広告、マーケ計測ピクセル、A/Bテスト、
  チャット/接客ウィジェット、タグマネージャ（GTM等）、SNS埋め込み、
  **外部Webフォント配信（Google Fonts 等 `fonts.googleapis.com` /
  `fonts.gstatic.com`）** など。
- **除外する（重要）**: **パブリックCDNからのJSライブラリ読み込み**
  （jsDelivr / cdnjs / unpkg / code.jquery.com / `ajax.googleapis.com` 等）。
  - 理由: jQuery等をCDNで読んでいても **自社配信に容易に置換可能** であり、
    「中身を自社が変えられない外部依存」というサードパーティタグの本質に
    当てはまらないため。分類上は別枠（"置換可能なCDNライブラリ"）とする。
  - ★ **Google Fonts はサードパーティタグに含める**（除外しない）。
    フォントはテキスト描画のブロッキング／レンダリング遅延に直結し、
    外部ドメイン依存として速い/遅いの差に効くため。
    （※ JSライブラリCDNの `ajax.googleapis.com` と、フォントの
    `fonts.googleapis.com`/`fonts.gstatic.com` はホストで区別すること。）

実装:
- ドメイン→エンティティ／カテゴリ分類は `third-party-web`（Lighthouse 同梱の
  分類器）を基礎に使う。さらに **CDNライブラリ用ホストの除外リスト** を自前で
  持ち、`utility`/CDN 系を「サードパーティタグから除外」する。
- ファーストパーティは計測対象URLの eTLD+1（およびサブドメイン）で判定。

### 4.2 集計項目

| 観点 | 内容 |
|---|---|
| タグ総数 | サードパーティタグの本数（CDNライブラリ除外後） |
| 総転送量 | サードパーティタグ合計バイト |
| **メインスレッドCPU消費** | サードパーティタグが消費した合計CPU時間（`third-party-summary` の mainThreadTime） |
| **ドメイン別内訳** | ドメイン（ホスト）ごとの **ファイル数 / 転送量 / 所要時間 / CPU** |
| ベンダー／エンティティ別内訳 | GA, GTM, Facebook, X, ホットジャー… ごとの 本数/バイト/CPU |
| カテゴリ別内訳 | analytics / ad / social / tag-manager / customer-success など |
| **LCP前 / LCP後の振り分け（補助）** | 各タグ・各ドメインの分量を `[0,LCP]` と `[LCP,end]` に振り分け（LCP前は妨害寄与、LCP後は遅延読込の参考） |
| ブロッキング寄与 | レンダーブロッキング or Long Task を生んだサードパーティタグ |
| 除外したCDNライブラリ | 参考として別枠で本数/バイトを表示（透明性のため） |

集計の粒度は **リクエスト単位 → ドメイン単位 → エンティティ単位** で
ロールアップする。最小単位（1リクエスト）に `domain / entity / category /
isThirdPartyTag / bytes / duration / cpuMs / beforeLCP` を持たせ、
任意の軸で `groupBy` して集計できるようにする。

→ サイト間で「タグ総数・総バイト・CPU・LCP前分量」を並べて、速いサイトとの
差を可視化。**何を削れば効くか** をベンダー別ランキングで提示。

---

## 5. Analyzer 3: Google Tag Manager 詳細分析

GTM はサードパーティタグの「元締め」。GTM を使うサイトが非常に多いので、
コンテナの中身まで踏み込んで「タグを盛りすぎていないか」を分析する。

### 5.1 取得方法（トレースに本文は無い → HTTP取得）

- トレース／DevtoolsLog から GTM コンテナの読み込みURLを検出:
  - `https://www.googletagmanager.com/gtm.js?id=GTM-XXXXXXX`（GTMコンテナ）
  - `https://www.googletagmanager.com/gtag/js?id=G-XXXX / AW-XXXX`（gtag直）
- 検出した **各コンテナURLを実際に HTTP GET** してスクリプト本文を取得。
- gtm.js 内の設定データ（`var data = {"resource":{...}}` 構造）をパースする。
  - 構造は非公開・難読寄りなので **防御的にパース**（壊れても部分集計で続行）。

### 5.2 集計項目

| 観点 | 内容 |
|---|---|
| **コンテナ数** | 読み込まれている GTM コンテナ（GTM-xxx）の数 |
| コンテナごとの容量 | gtm.js の転送量 / 展開後サイズ |
| **タグ設定数** | コンテナ内に定義されたタグの総数 |
| タグ種別の内訳 | 関数タイプ別（`__html` カスタムHTML, `__gaawe` GA4イベント, `__googtag`, `__ua`, conversion linker, Floodlight 等）の件数 |
| トリガー数 | 発火条件（predicates/rules）の数・種類 |
| 変数（マクロ）数 | 定義済み変数の数・種類 |
| **発火タイミング別** | pageview / DOM Ready / window load / カスタムイベント など、いつ発火するタグがどれだけあるか |
| カスタムHTMLタグ | 任意JSを注入する `__html` タグの数（重い・危険の温床） |
| 重複・未使用の気配 | 同種タグの乱立、使われていなさそうな設定 |

→ 「自社コンテナはタグ◯個・カスタムHTML◯個・pageview発火◯個」を速いサイトと
並べ、**GTM の肥大化** を反省してもらう。タグ種別の内訳円グラフが効く。

### 5.3 注意

- gtm.js の内部フォーマットは Google 都合で変わりうる。バージョン差を吸収する
  パーサにし、解釈できない項目は "unknown" として件数だけでも残す。
- ここで得た「GTM配下のタグ内訳」と、Analyzer2 の「実際にネットワーク/CPUに
  現れたサードパーティタグ」を突き合わせると、**設定 vs 実負荷** が見える。

---

## 6. Analyzer 4（将来）: 画像分析

- 画像の枚数・総バイト、LCP前に読まれた画像量。
- 過大画像（表示サイズ>実寸の何倍か）、非次世代フォーマット、未圧縮。
- 読み込みが遅い画像 / lazy 漏れ / 優先度の付け方。
- （詳細は将来詰める。本ドキュメントでは枠だけ確保。）

---

## 7. レポート出力イメージ（サイトを並べて読む）

`compare` は作らない。各サイトのレポートを出力し、人が横に並べて見る。
ただし各レポートは「速いサイトと比べてどうか」を意識した見出しにする。

### 7.1 LCP到達分析（1サイト分の例）

```
== LCP到達分析: https://example.com (mobile) ==
TTFB                 480ms
FCP / LCP            2.1s / 4.8s
LCP内訳  TTFB 480 / LoadDelay 1900 / LoadTime 1100 / RenderDelay 320 ms
[0,LCP] Scripting    1400ms   Idle(net待ち) 1800ms
HTML TTFB            480ms    CSSが揃う 1.6s
Waiting合計/DL合計    2.4s / 1.2s  → レイテンシー律速
CRP最長パス          2.2s     CRP妨害(並走非必須) 900KB
LCP前 リクエスト48本 / 2.8MB
LCP画像  fetchpriority=auto / preload無 / priority=Low  ★最優先化されていない
```

### 7.2 サードパーティタグ分析（1サイト分の例）

```
== サードパーティタグ: https://example.com ==
タグ総数 23 / 総転送量 1.4MB / CPU 1200ms
LCP前に読まれた分 14本 / 800KB / CPU 700ms   ★LCPを妨害
ベンダー別 CPU上位:
  1. GTM            520ms / 12本
  2. Facebook Pixel 180ms
  3. Hotjar         150ms
(除外したCDNライブラリ: 3本 / 90KB)  ← 置換可能なので対象外
```

### 7.3 GTM詳細（1サイト分の例）

```
== GTM詳細: example.com ==
コンテナ 2個 (GTM-AAA 180KB, GTM-BBB 60KB)
タグ総数 78
  カスタムHTML 31 / GA4イベント 22 / 広告コンバージョン 14 / その他 11
トリガー 41 / 変数 96
発火タイミング: pageview 40 / DOM Ready 18 / window load 9 / カスタム 11
```

---

## 8. 実装メモ / 想定パッケージ構成

- 依存: `lighthouse`, `chrome-launcher`, `third-party-web`。
  trace解析は自前 or `@paulirish/trace_engine`。GTM取得は `undici`/fetch。
- モジュール案:
  - `capture/` … Lighthouse 実行 + artifacts 保存（複数回→中央値）。
  - `core/trace/` … trace パース（マーカー / メインスレッド内訳 / Long Task）。
  - `core/network/` … DevtoolsLog からリソース集計（種別/優先度/タイミング）。
  - `analyzers/lcp/` … Analyzer 1（LCP到達分析）。
  - `analyzers/third-party/` … Analyzer 2（タグ分量・CPU・除外ロジック）。
  - `analyzers/gtm/` … Analyzer 3（コンテナHTTP取得＋設定パース）。
  - `analyzers/images/` … Analyzer 4（将来）。
  - `report/` … JSON + Markdown/表 出力。
- アナライザ共通IF（イメージ）:
  ```ts
  interface Analyzer<T> {
    name: string
    analyze(input: { artifacts, fetch }): Promise<T>   // 同じ artifacts を受ける
    toReport(result: T): { json: object; markdown: string }
  }
  ```
- CLI イメージ（compare は無し。capture と各 analyze）:
  ```
  third-party-analyzer capture <url> --out ./runs/example
  third-party-analyzer analyze lcp          ./runs/example
  third-party-analyzer analyze third-party  ./runs/example
  third-party-analyzer analyze gtm          ./runs/example
  # 速いサイトと自社サイトでそれぞれ実行し、レポートを並べて読む
  ```

---

## 9. 解釈の答え合わせ / 裏どり（Perfetto）

トレースの解釈が正しいかの検証に、ローカルに置いた Perfetto を使う。

- 参照: `~/dev/study/perfetto`（Perfetto 本体のソース一式・`docs/` 含む。google/perfetto のクローン）。
- 使い方:
  - **イベント意味の確認**: `docs/` でトレースイベント／スライスの定義を確認し、
    自前パースのカテゴリ分類（Scripting/Rendering 等）が妥当か答え合わせ。
  - **目視ドリルダウン**: `trace.json` を `ui.perfetto.dev` に読み込み、
    LCP までのタイムライン・帯域競合・妨害構造を目で確認。
  - **SQL裏どり（任意）**: `trace_processor` でスライス種別ごとの合計時間等を
    SQL集計し、自前集計値と一致するか突き合わせる。
- ただし Perfetto は **検証・裏どり用**。本パイプラインの必須依存にはしない
  （実行時は Lighthouse artifacts ＋ 軽量パースで完結させる）。

---

## 10. 注意点 / 落とし穴

- **計測のブレ**: 単発は不安定。複数回の中央値、同一throttling、ウォームアップ。
- **基準時刻**: 全イベントを `navigationStart` 基準で正規化してから比較する。
- **LCP候補の確定**: `largestContentfulPaint::Candidate` は複数出る→最後を採用。
- **trace と devtoolslog の突き合わせ**: requestId / url で対応付ける。
- **キャッシュ条件**: cold/warm を揃える（公平比較のため）。
- **サードパーティ判定の精度**: `third-party-web` の分類＋自前CDN除外リストの
  メンテが品質を左右する。誤分類は別枠表示で透明化する。
- **GTMフォーマット変更**: gtm.js 内部構造は変わりうる→防御的パース＋unknown集計。
- **HTTP取得の再現性**: GTMコンテナ取得は計測時点と差異が出うる→取得時刻を記録。
- **CLS等は対象外**: 今回は performance / FCP・LCP・タグ負荷に集中。
