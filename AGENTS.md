# jev-playground

TypeSafe AI の Jev（文章を生成せず、型付きの判断と確率を返す System One model）を試す playground。
LLM の prompt-and-parse を構造化された判断に置き換えられるか、確率が閾値として使えるかを、手元のデータで確かめる。

## ディレクトリ構造

```
jev-playground/
├── examples/        1 ファイル 1 実験の直線的な script
├── results/         実験の出力（gitignore）
├── bunfig.toml      exact pin + 7 日 cooldown
└── mise.toml        bun の版
```

## セットアップ

ツールは mise で管理している。

```bash
mise install
bun install
```

API key は `TYPESAFE_API_KEY`。dotfiles の global mise config に age 暗号文で入っており、mise activate 済みの対話 shell でだけ env に出る。agent の Bash からは `zsh -ic '...'` 経由で実行する。

```bash
bun run examples/triage.ts
bun run typecheck
```

## 技術スタック

- Bun + TypeScript
- `@typesafe-ai/sdk`（質問定義から answer の型を推論する）

## Jev の前提

API 契約・limit・model の SSOT は live docs（https://docs.typesafe.ai/llms.txt ）。設計の指針は global の `typesafe-ai` skill。

- endpoint は `POST /v1/systemone` の 1 本。`state`（判断材料）と `questions`（`noul` / `choice` / `score`）を渡す
- prompt に当たるのは各 question の `instructions` と `criteria` だけ。`questions` の key はモデルに渡らない
- 同じ `state` への複数の質問は並列に評価され、互いの答えは見えない
- 入力 $0.042 / 1M token、出力無料。`state` + 最長の質問で 32k token まで
- 英語が最も精度が高く、日本語は docs 上「信頼性が落ちる」扱い

## データの扱い

リクエストは学習に使われないが、保存期間は明記されておらず ZDR は enterprise のみ。渡してよいのは個人の責任範囲のデータだけで、業務データ・`.local` ファイルは渡さない。

## 実験の作法

- 正解ラベルのあるデータで測る。指標は AUC・Brier score・reliability curve
- 比較対象（logprobs が取れる安い model など）を並べる。Jev 単体の数字では採否を決められない
- ジャンルや長さがラベルと交絡していないかを先に見る
