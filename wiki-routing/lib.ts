import { join } from "node:path";

export const WIKI_DIR = process.env.WIKI_DIR ?? "/Users/yuito_watanabe/src/github.com/wwwyo/me/wiki";
export const RESULTS_DIR = join(import.meta.dir, "..", "results", "wiki-routing");

export interface WikiPage {
  /** posix path relative to WIKI_DIR */
  path: string;
  title: string;
  description: string;
  /** markdown body after the frontmatter block */
  body: string;
}

export interface ExcludedPage {
  path: string;
  reason: string;
}

export interface LoadWikiPagesResult {
  pages: WikiPage[];
  excluded: ExcludedPage[];
}

const EXCLUDED_BASENAMES = new Set(["index.md", "log.md", "AGENTS.md"]);

function parseFrontmatter(text: string): { title?: string; description?: string; body: string } | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const front = match[1] ?? "";
  const body = match[2] ?? "";
  const titleMatch = front.match(/^title:\s*(.+)$/m);
  const descriptionMatch = front.match(/^description:\s*(.+)$/m);
  return {
    title: titleMatch?.[1]?.trim(),
    description: descriptionMatch?.[1]?.trim(),
    body,
  };
}

/**
 * Loads the routable wiki pages: everything under `**\/*.md` except `*.local.md`,
 * `index.md`, `log.md`, and `AGENTS.md`. Pages without a parseable frontmatter or
 * missing title/description are reported in `excluded` rather than silently dropped,
 * since a routing target needs both fields to be askable about.
 */
export async function loadWikiPages(wikiDir: string): Promise<LoadWikiPagesResult> {
  const glob = new Bun.Glob("**/*.md");
  const pages: WikiPage[] = [];
  const excluded: ExcludedPage[] = [];
  for await (const rel of glob.scan({ cwd: wikiDir })) {
    const base = rel.split("/").pop() ?? rel;
    if (EXCLUDED_BASENAMES.has(base) || base.endsWith(".local.md")) continue;
    const text = await Bun.file(join(wikiDir, rel)).text();
    const fm = parseFrontmatter(text);
    if (!fm) {
      excluded.push({ path: rel, reason: "no frontmatter" });
      continue;
    }
    if (!fm.title) {
      excluded.push({ path: rel, reason: "missing title" });
      continue;
    }
    if (!fm.description) {
      excluded.push({ path: rel, reason: "missing description" });
      continue;
    }
    pages.push({ path: rel, title: fm.title, description: fm.description, body: fm.body });
  }
  pages.sort((a, b) => a.path.localeCompare(b.path));
  return { pages, excluded };
}

/** Deterministic PRNG (mulberry32) so sampling is reproducible from a fixed seed. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleN<T>(items: readonly T[], n: number, seed: number): T[] {
  const arr = items.slice();
  const rand = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = arr[i];
    const b = arr[j];
    if (a === undefined || b === undefined) continue;
    arr[i] = b;
    arr[j] = a;
  }
  return arr.slice(0, n);
}

export async function pMap<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      const item = items[i];
      if (item === undefined) return;
      results[i] = await fn(item, i);
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function stripCodeFence(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return match?.[1] ?? text;
}

export interface OpenCodeUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface OpenCodeResult {
  content: string;
  usage: OpenCodeUsage;
}

const OPENCODE_URL = "https://opencode.ai/zen/go/v1/chat/completions";
const OPENCODE_MODEL = "deepseek-v4.1-flash";
// One id per process run: Go asks for a session id stable across a "conversation"
// so it can route and cache consistently; a fresh script run is a fresh conversation.
const OPENCODE_SESSION = `wiki-routing-poc-${crypto.randomUUID()}`;

function readOpenCodeResponse(value: unknown): { content: string; usage: OpenCodeUsage } {
  if (!isRecord(value)) throw new Error("opencode response is not an object");
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error("opencode response has no choices");
  const first = choices[0];
  if (!isRecord(first)) throw new Error("opencode choice is not an object");
  const message = first.message;
  if (!isRecord(message)) throw new Error("opencode message is not an object");
  const content = message.content;
  if (typeof content !== "string") throw new Error("opencode message.content is not a string");
  const usage = value.usage;
  if (!isRecord(usage)) throw new Error("opencode response has no usage");
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  if (typeof promptTokens !== "number" || typeof completionTokens !== "number") {
    throw new Error("opencode usage fields are not numbers");
  }
  return { content, usage: { promptTokens, completionTokens } };
}

export async function opencodeChat(prompt: string, opts?: { json?: boolean }): Promise<OpenCodeResult> {
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey) throw new Error("OPENCODE_API_KEY is not set");
  const res = await fetch(OPENCODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "wiki-routing-poc/0.1",
      "x-opencode-session": OPENCODE_SESSION,
    },
    body: JSON.stringify({
      model: OPENCODE_MODEL,
      messages: [{ role: "user", content: prompt }],
      ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text();
    throw new Error(`opencode chat failed: ${res.status} ${bodyText}`);
  }
  const json: unknown = await res.json();
  return readOpenCodeResponse(json);
}

export function median(nums: readonly number[]): number {
  if (nums.length === 0) return NaN;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const midVal = sorted[mid];
  if (midVal === undefined) return NaN;
  if (sorted.length % 2 === 0) {
    const lower = sorted[mid - 1];
    return lower === undefined ? midVal : (lower + midVal) / 2;
  }
  return midVal;
}

export function percentile(nums: readonly number[], p: number): number {
  if (nums.length === 0) return NaN;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  const v = sorted[idx];
  return v === undefined ? NaN : v;
}

export function mean(nums: readonly number[]): number {
  if (nums.length === 0) return NaN;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
