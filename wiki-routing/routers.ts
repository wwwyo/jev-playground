import { noul, type NoulQuestion, TypeSafeClient } from "@typesafe-ai/sdk";
import { isRecord, opencodeChat, stripCodeFence, type WikiPage } from "./lib";

export interface RankedRun {
  /** page paths ranked most-to-least relevant; may be a prefix (e.g. top 10) */
  ranking: string[];
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface JevRun extends RankedRun {
  inputTokens: number;
  outputTokens: number;
  /** probability of "should reference" per page path, full coverage */
  probsByPath: Map<string, number>;
}

// 1000 問・49k token の 1 リクエストが通ることを実測済みなので、batch に分割しない。
export async function jevRoute(client: TypeSafeClient, query: string, pages: readonly WikiPage[]): Promise<JevRun> {
  const keyToPath = new Map<string, string>();
  const questions: Record<string, NoulQuestion> = {};
  pages.forEach((page, i) => {
    const key = `p${i}`;
    keyToPath.set(key, page.path);
    questions[key] = noul(
      `Should this wiki page be referenced to answer the user's query \`query\`? Page title: ${page.title}. Page description: ${page.description}.`,
      {
        true: "The page's subject directly supplies the answer to `query`.",
        false: "The page is unrelated or only tangential to `query`.",
      },
    );
  });

  const start = performance.now();
  const { answers, usage } = await client.systemOne({ state: { query }, questions });
  const latencyMs = performance.now() - start;

  const probsByPath = new Map<string, number>();
  for (const [key, answer] of Object.entries(answers)) {
    const path = keyToPath.get(key);
    if (path === undefined) continue;
    probsByPath.set(path, answer.noul);
  }
  const ranking = [...probsByPath.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);

  return { ranking, probsByPath, latencyMs, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

function parseRankingResponse(content: string, pages: readonly WikiPage[]): string[] {
  const parsed: unknown = JSON.parse(stripCodeFence(content));
  if (!isRecord(parsed)) throw new Error("llm ranking response is not an object");
  const ranking = parsed.ranking;
  if (!Array.isArray(ranking)) throw new Error("llm ranking response has no `ranking` array");
  const paths: string[] = [];
  for (const n of ranking) {
    if (typeof n !== "number") continue;
    const page = pages[n - 1];
    if (page !== undefined) paths.push(page.path);
  }
  return paths;
}

export async function llmRoute(query: string, pages: readonly WikiPage[]): Promise<RankedRun> {
  const listing = pages.map((page, i) => `${i + 1}. ${page.title} — ${page.description}`).join("\n");
  const prompt = `A user, in the middle of their own work, asked their AI agent this question. From the numbered list of wiki pages below, pick the 10 most relevant to answering it, ordered from most to least relevant.

Return strict JSON only, no markdown fence: {"ranking": [n1, n2, ...]} with page numbers.

Question: ${query}

Pages:
${listing}`;

  const start = performance.now();
  const { content, usage } = await opencodeChat(prompt, { json: true });
  const latencyMs = performance.now() - start;
  const ranking = parseRankingResponse(content, pages);
  return { ranking, latencyMs, inputTokens: usage.promptTokens, outputTokens: usage.completionTokens };
}

function bigrams(text: string): string[] {
  const s = text.replace(/\s+/g, "");
  if (s.length < 2) return s.length === 1 ? [s] : [];
  const grams: string[] = [];
  for (let i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2));
  return grams;
}

function termFreq(tokens: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export interface BigramIndex {
  idf: Map<string, number>;
  docVectors: Map<string, Map<string, number>>;
  docNorms: Map<string, number>;
}

/** Character-bigram TF-IDF over `title + description`, smoothed idf (sklearn-style). */
export function buildBigramIndex(pages: readonly WikiPage[]): BigramIndex {
  const docsTf = new Map<string, Map<string, number>>();
  const df = new Map<string, number>();
  for (const page of pages) {
    const tf = termFreq(bigrams(`${page.title} ${page.description}`));
    docsTf.set(page.path, tf);
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const docCount = pages.length;
  const idf = new Map<string, number>();
  for (const [term, d] of df) idf.set(term, Math.log((1 + docCount) / (1 + d)) + 1);

  const docVectors = new Map<string, Map<string, number>>();
  const docNorms = new Map<string, number>();
  for (const [path, tf] of docsTf) {
    const vec = new Map<string, number>();
    let normSq = 0;
    for (const [term, count] of tf) {
      const weight = count * (idf.get(term) ?? 0);
      vec.set(term, weight);
      normSq += weight * weight;
    }
    docVectors.set(path, vec);
    docNorms.set(path, Math.sqrt(normSq));
  }
  return { idf, docVectors, docNorms };
}

export function bigramRoute(query: string, pages: readonly WikiPage[], index: BigramIndex): RankedRun {
  const start = performance.now();
  const qtf = termFreq(bigrams(query));
  const qvec = new Map<string, number>();
  let qNormSq = 0;
  for (const [term, count] of qtf) {
    const weight = count * (index.idf.get(term) ?? 0);
    qvec.set(term, weight);
    qNormSq += weight * weight;
  }
  const qNorm = Math.sqrt(qNormSq);

  const scored = pages.map((page) => {
    const dvec = index.docVectors.get(page.path);
    const dnorm = index.docNorms.get(page.path);
    if (!dvec || dnorm === undefined || dnorm === 0 || qNorm === 0) return { path: page.path, score: 0 };
    let dot = 0;
    for (const [term, weight] of qvec) {
      const dw = dvec.get(term);
      if (dw !== undefined) dot += dw * weight;
    }
    return { path: page.path, score: dot / (dnorm * qNorm) };
  });
  scored.sort((a, b) => b.score - a.score);
  const latencyMs = performance.now() - start;
  return { ranking: scored.map((s) => s.path), latencyMs };
}
