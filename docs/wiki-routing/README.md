# wiki-routing

自然文の問いから、個人 wiki（約 200 ページの markdown）のどのページを参照すべきかを選ぶ routing の PoC。

## 確かめたいこと

agent が wiki を参照するとき、今は router の `index.md` と domain ごとの一覧を LLM が読んで当たりを付けている。この「どのページを読むか」の判断を Jev の型付き判断に置き換えられるか。置き換える価値があるのは、LLM に一覧を読ませる方法と同等以上の精度が、より安く速く出る場合だけである。

## 方式

ページごとに frontmatter の `title` と `description` を取り出し、1 ページを 1 問の `noul`（「この問いに答えるためにこのページを参照すべきか」）にする。`state` は問いだけを持つ。全ページ分の質問を数リクエストに分けて並列に投げ、返ってきた確率の降順をそのまま順位にする。

domain を先に `choice` で絞る階層化は入れていない。全件に聞いても 1 クエリ約 3 万 token（$0.0015 前後）で済む見込みなので、精度か latency が足りないと分かってから足す。

## 評価

- 評価セット: 無作為に選んだ 40 ページについて、「そのページが答えになる自然な日本語の問い」を LLM に 1 つずつ作らせる。title の語はそのまま使わせない。正解はそのページ
- 指標: recall@1 / @5 / @10、MRR、1 クエリあたりの latency と費用。Jev については、正解ページに付いた確率の分布と、不正解ページに 0.5 以上が付いた件数も見る
- 比較対象
  - `llm`: 全ページの一覧を 1 prompt で渡し、関連順に上位 10 件を選ばせる。今の運用の安価版で、Jev が超えるべき相手
  - `bigram`: title と description の文字 bigram TF-IDF。キーワード検索相当の下限

## 分かっている弱点

- 問いは合成で、正解は 1 問につき 1 ページしかない。実際の参照は複数ページにまたがることが多い
- 問いを作る LLM と `llm` router が同じ model なので、`llm` に有利な偏りが入りうる
- wiki は日本語で、Jev は日本語の信頼性が落ちると docs に明記されている
- description の質に結果が左右される。description が曖昧なページは、どの方式でも当たらない

## データの扱い

wiki の中身はこの repo に入れない。実行時に `WIKI_DIR`（既定は `~/src/github.com/wwwyo/me/wiki`）から読み、生成した問い・cache・結果は gitignore 済みの `results/wiki-routing/` に置く。`*.local.md` は対象から除く。

## 実行

```bash
bun run wiki-routing:queries    # 評価セットを作る（既にあれば再利用）
bun run wiki-routing:evaluate   # 3 つの router を評価して results/wiki-routing/summary.md に出す
```

`TYPESAFE_API_KEY` と `OPENCODE_API_KEY` が要る。

| ファイル | 役割 |
| --- | --- |
| `lib.ts` | wiki の読み込み、seed 固定の抽出、opencode の呼び出し |
| `generate-queries.ts` | 評価セットの生成 |
| `routers.ts` | `jev` / `llm` / `bigram` の 3 router |
| `evaluate.ts` | 指標の計算と集計 |

## 結果（1 回目、216 ページ・40 問）

| router | recall@1 | recall@5 | MRR | latency 中央値 / p95 | 1 クエリの費用 |
| --- | --- | --- | --- | --- | --- |
| `jev` | 0.925 | 0.975 | 0.948 | 0.5 秒 / 1.2 秒 | $0.0015（36.8k token） |
| `llm`（deepseek-v4.1-flash） | 0.975 | 1.000 | 0.988 | 10.4 秒 / 55.9 秒 | 定額制のため未算出（入力 16.4k、出力 4.2k token） |
| `bigram` | 0.675 | 0.950 | 0.783 | 1 ミリ秒 | 0 |

- `jev` は 216 問を 1 リクエストに載せられた。事前の確認では 1000 問・49k token でも通り、質問数の上限は見つかっていない
- `jev` が正解ページに付けた確率は中央値 0.92、最小 0.26。不正解ページに 0.5 以上が付く件数は 1 クエリあたり平均 2.3
- `jev` が 10 位以内に入れられなかった 1 問は、抽象度の高い方針ページが正解の問いだった

### index をたどる agent との比較（10 問）

同じ評価セットから seed 固定で 10 問を選び、context が空の subagent（Claude Sonnet）に 1 問ずつ渡した。subagent は `index.md` → domain の `index.md` → 候補ページの本文、の順に Read だけでたどる。grep は禁止した。

| 方式 | 正解が 1 位 | 所要時間 | routing で増える context |
| --- | --- | --- | --- |
| index をたどる subagent | 10 / 10 | 17〜34 秒（中央値 24 秒） | 平均 29k token（Read 3〜7 回） |
| `jev` | 9 / 10（残り 1 問は 2 位） | 中央値 0.56 秒 | 上位 5 件の path を返すだけなら約 200 token |
| `llm` | 10 / 10 | 中央値 8.6 秒 | 同上 |
| `bigram` | 7 / 10（残り 3 問は 3 位） | 1 ミリ秒未満 | 同上 |

- subagent の token は、何もしない subagent の 72k token を差し引いた増分。増分の大半は domain の一覧（tech の `index.md` だけで約 37KB）を読む分で、正解ページの本文を読む分は答えるためにどのみち要る
- 10 問では精度の差は検出できない。差が出たのは時間と context で、どちらも 2 桁違う

精度は `llm` がわずかに上で、速度は `jev` が約 20 倍速い。ただし「分かっている弱点」のとおり、問いを作った model と `llm` router が同じなので、精度の差はそのまま受け取れない。
