import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { RESULTS_DIR, WIKI_DIR, isRecord, loadWikiPages, mean, median, percentile, pMap, type WikiPage } from "./lib";
import { bigramRoute, buildBigramIndex, jevRoute, llmRoute, type RankedRun } from "./routers";

const QUERIES_PATH = join(RESULTS_DIR, "queries.json");
const JEV_COST_PER_MILLION_INPUT_TOKENS = 0.042;

interface QueryEntry {
  query: string;
  target: string;
}

interface QueryOutcome {
  query: string;
  target: string;
  targetTitle: string;
  /** 1-indexed rank of the target within the router's returned ranking, or null if absent */
  rank: number | null;
  top1Title: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  targetProb?: number;
  falsePositivesOver50?: number;
}

interface RouterMetrics {
  name: string;
  n: number;
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  latencyMedianMs: number;
  latencyP95Ms: number;
  avgInputTokens?: number;
  avgOutputTokens?: number;
  avgCostUsd?: number;
  jevTargetProb?: { mean: number; median: number; min: number };
  jevAvgFalsePositivesOver50?: number;
  failures: { query: string; targetTitle: string; top1Title: string }[];
}

function parseQueries(value: unknown): QueryEntry[] {
  if (!Array.isArray(value)) throw new Error("queries.json is not an array");
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw new Error(`queries.json[${i}] is not an object`);
    const query = entry.query;
    const target = entry.target;
    if (typeof query !== "string" || typeof target !== "string") {
      throw new Error(`queries.json[${i}] missing string query/target`);
    }
    return { query, target };
  });
}

function rankOf(ranking: readonly string[], target: string): number | null {
  const idx = ranking.indexOf(target);
  return idx === -1 ? null : idx + 1;
}

function titleOf(pages: readonly WikiPage[], path: string): string {
  return pages.find((p) => p.path === path)?.title ?? `(unknown: ${path})`;
}

function toOutcome(
  run: RankedRun,
  entry: QueryEntry,
  pages: readonly WikiPage[],
  extra?: { targetProb?: number; falsePositivesOver50?: number },
): QueryOutcome {
  const rank = rankOf(run.ranking, entry.target);
  const top1 = run.ranking[0];
  return {
    query: entry.query,
    target: entry.target,
    targetTitle: titleOf(pages, entry.target),
    rank,
    top1Title: top1 === undefined ? "(no results)" : titleOf(pages, top1),
    latencyMs: run.latencyMs,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    ...extra,
  };
}

function summarize(name: string, outcomes: readonly QueryOutcome[]): RouterMetrics {
  const n = outcomes.length;
  const recallAt = (k: number) => outcomes.filter((o) => o.rank !== null && o.rank <= k).length / n;
  const mrr = outcomes.reduce((acc, o) => acc + (o.rank !== null ? 1 / o.rank : 0), 0) / n;
  const latencies = outcomes.map((o) => o.latencyMs);

  const inputTokensList = outcomes.map((o) => o.inputTokens).filter((v): v is number => v !== undefined);
  const outputTokensList = outcomes.map((o) => o.outputTokens).filter((v): v is number => v !== undefined);

  const targetProbs = outcomes.map((o) => o.targetProb).filter((v): v is number => v !== undefined);
  const falsePositives = outcomes.map((o) => o.falsePositivesOver50).filter((v): v is number => v !== undefined);

  const failures = outcomes
    .filter((o) => o.rank === null || o.rank > 10)
    .slice(0, 5)
    .map((o) => ({ query: o.query, targetTitle: o.targetTitle, top1Title: o.top1Title }));

  return {
    name,
    n,
    recallAt1: recallAt(1),
    recallAt5: recallAt(5),
    recallAt10: recallAt(10),
    mrr,
    latencyMedianMs: median(latencies),
    latencyP95Ms: percentile(latencies, 95),
    avgInputTokens: inputTokensList.length > 0 ? mean(inputTokensList) : undefined,
    avgOutputTokens: outputTokensList.length > 0 ? mean(outputTokensList) : undefined,
    avgCostUsd:
      name === "jev" && inputTokensList.length > 0
        ? mean(inputTokensList.map((t) => (t / 1_000_000) * JEV_COST_PER_MILLION_INPUT_TOKENS))
        : undefined,
    jevTargetProb:
      targetProbs.length > 0
        ? { mean: mean(targetProbs), median: median(targetProbs), min: Math.min(...targetProbs) }
        : undefined,
    jevAvgFalsePositivesOver50: falsePositives.length > 0 ? mean(falsePositives) : undefined,
    failures,
  };
}

function fmt(n: number, digits = 3): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "N/A";
}

function renderMetrics(m: RouterMetrics): string {
  const lines: string[] = [];
  lines.push(`### ${m.name} (n=${m.n})`);
  lines.push("");
  lines.push(`- recall@1: ${fmt(m.recallAt1)}  recall@5: ${fmt(m.recallAt5)}  recall@10: ${fmt(m.recallAt10)}`);
  lines.push(`- MRR: ${fmt(m.mrr)}`);
  lines.push(`- latency: median ${fmt(m.latencyMedianMs, 0)}ms, p95 ${fmt(m.latencyP95Ms, 0)}ms`);
  if (m.avgInputTokens !== undefined) {
    lines.push(
      `- tokens/query: input avg ${fmt(m.avgInputTokens, 0)}${m.avgOutputTokens !== undefined ? `, output avg ${fmt(m.avgOutputTokens, 0)}` : ""}`,
    );
  } else {
    lines.push("- tokens/query: N/A (no API call)");
  }
  if (m.avgCostUsd !== undefined) {
    lines.push(`- cost/query: $${m.avgCostUsd.toFixed(6)} (input tokens only, $${JEV_COST_PER_MILLION_INPUT_TOKENS}/1M)`);
  } else if (m.name === "llm") {
    lines.push("- cost/query: N/A (opencode Go is a flat-rate subscription, not metered per token here)");
  }
  if (m.jevTargetProb) {
    lines.push(
      `- target-page probability: mean ${fmt(m.jevTargetProb.mean)}, median ${fmt(m.jevTargetProb.median)}, min ${fmt(m.jevTargetProb.min)}`,
    );
  }
  if (m.jevAvgFalsePositivesOver50 !== undefined) {
    lines.push(`- avg non-target pages with prob >= 0.5: ${fmt(m.jevAvgFalsePositivesOver50)}`);
  }
  lines.push("");
  if (m.failures.length > 0) {
    lines.push(`Failures (target outside top 10), up to 5 of ${m.n - Math.round(m.recallAt10 * m.n)}:`);
    for (const f of m.failures) {
      lines.push(`- query: "${f.query}"`);
      lines.push(`  target: ${f.targetTitle}`);
      lines.push(`  rank1 instead: ${f.top1Title}`);
    }
  } else {
    lines.push("Failures: none (target always in top 10).");
  }
  lines.push("");
  return lines.join("\n");
}

function parseArgs(argv: readonly string[]): { limit?: number; routers: string[] } {
  let limit: number | undefined;
  let routers = ["jev", "llm", "bigram"];
  for (const arg of argv) {
    if (arg.startsWith("--limit=")) limit = Number(arg.slice("--limit=".length));
    if (arg.startsWith("--routers=")) routers = arg.slice("--routers=".length).split(",");
  }
  return { limit, routers };
}

async function main(): Promise<void> {
  const { limit, routers } = parseArgs(process.argv.slice(2));

  const queriesFile = Bun.file(QUERIES_PATH);
  if (!(await queriesFile.exists())) {
    throw new Error(`${QUERIES_PATH} not found; run generate-queries.ts first`);
  }
  const allQueries = parseQueries(await queriesFile.json());
  const queries = limit !== undefined ? allQueries.slice(0, limit) : allQueries;
  console.log(`evaluating ${queries.length} of ${allQueries.length} queries against: ${routers.join(", ")}`);

  const { pages, excluded } = await loadWikiPages(WIKI_DIR);
  console.log(`loaded ${pages.length} routable pages, excluded ${excluded.length}`);

  const metrics: RouterMetrics[] = [];

  if (routers.includes("jev")) {
    const client = new TypeSafeClient();
    const outcomes = await pMap(
      queries,
      async (entry) => {
        const run = await jevRoute(client, entry.query, pages);
        const targetProb = run.probsByPath.get(entry.target);
        const falsePositivesOver50 = [...run.probsByPath.entries()].filter(
          ([path, prob]) => path !== entry.target && prob >= 0.5,
        ).length;
        return toOutcome(run, entry, pages, { targetProb, falsePositivesOver50 });
      },
      8,
    );
    await Bun.write(join(RESULTS_DIR, "results-jev.json"), `${JSON.stringify(outcomes, null, 2)}\n`);
    metrics.push(summarize("jev", outcomes));
  }

  if (routers.includes("llm")) {
    const outcomes = await pMap(
      queries,
      async (entry) => {
        const run = await llmRoute(entry.query, pages);
        return toOutcome(run, entry, pages);
      },
      5,
    );
    await Bun.write(join(RESULTS_DIR, "results-llm.json"), `${JSON.stringify(outcomes, null, 2)}\n`);
    metrics.push(summarize("llm", outcomes));
  }

  if (routers.includes("bigram")) {
    const index = buildBigramIndex(pages);
    const outcomes = queries.map((entry) => toOutcome(bigramRoute(entry.query, pages, index), entry, pages));
    await Bun.write(join(RESULTS_DIR, "results-bigram.json"), `${JSON.stringify(outcomes, null, 2)}\n`);
    metrics.push(summarize("bigram", outcomes));
  }

  const summaryLines: string[] = [];
  summaryLines.push("# wiki-routing evaluation");
  summaryLines.push("");
  summaryLines.push(`- wiki pages routable: ${pages.length}, excluded: ${excluded.length}`);
  if (excluded.length > 0) {
    for (const e of excluded) summaryLines.push(`  - ${e.path}: ${e.reason}`);
  }
  summaryLines.push(`- queries evaluated: ${queries.length} of ${allQueries.length} in queries.json`);
  summaryLines.push("");
  for (const m of metrics) summaryLines.push(renderMetrics(m));

  const summary = summaryLines.join("\n");
  console.log("");
  console.log(summary);
  await Bun.write(join(RESULTS_DIR, "summary.md"), summary);
}

await main();
