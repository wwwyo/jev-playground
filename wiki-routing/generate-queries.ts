import { join } from "node:path";
import { RESULTS_DIR, WIKI_DIR, isRecord, loadWikiPages, opencodeChat, pMap, sampleN, stripCodeFence, type WikiPage } from "./lib";

const SAMPLE_SEED = 42;
const SAMPLE_SIZE = 40;
const BODY_EXCERPT_CHARS = 1500;
const QUERIES_PATH = join(RESULTS_DIR, "queries.json");

interface QueryEntry {
  query: string;
  target: string;
}

function buildPrompt(page: WikiPage, avoidTitleRestated: boolean): string {
  const excerpt = page.body.slice(0, BODY_EXCERPT_CHARS);
  const extraRule = avoidTitleRestated
    ? "\n- Your previous attempt reused the page title's exact wording; this time paraphrase it away completely."
    : "";
  return `You are building an evaluation case for a document-routing system. A person is in the middle of their own focused work and asks their AI agent one natural question in Japanese. The wiki page below fully answers that question.

Write exactly one such question.

Rules:
- Japanese, 1 to 2 sentences.
- Do not reuse the page title's exact wording in the question.
- Phrase it like a real question someone would type mid-task, not "◯◯とは何か" or a dictionary-style definition request.
- Return strict JSON only, no markdown fence: {"query": "..."}${extraRule}

Page title: ${page.title}
Page description: ${page.description}
Page excerpt (may be cut off mid-sentence):
"""
${excerpt}
"""`;
}

function parseQueryResponse(content: string): string {
  const parsed: unknown = JSON.parse(stripCodeFence(content));
  if (!isRecord(parsed)) throw new Error("query response is not an object");
  const query = parsed.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("query response has no non-empty `query` string");
  }
  return query.trim();
}

async function generateQuery(page: WikiPage): Promise<string> {
  const first = await opencodeChat(buildPrompt(page, false), { json: true });
  const firstQuery = parseQueryResponse(first.content);
  if (!firstQuery.includes(page.title)) return firstQuery;

  // Retry once with a stronger instruction; accept the second attempt regardless,
  // since a synthetic-generation retry loop is not the thing under evaluation here.
  const second = await opencodeChat(buildPrompt(page, true), { json: true });
  return parseQueryResponse(second.content);
}

async function main(): Promise<void> {
  await Bun.$`mkdir -p ${RESULTS_DIR}`.quiet();

  const existingFile = Bun.file(QUERIES_PATH);
  if (await existingFile.exists()) {
    const existing: unknown = await existingFile.json();
    if (Array.isArray(existing) && existing.length > 0) {
      console.log(`${QUERIES_PATH} already has ${existing.length} entries; reusing. Delete it to regenerate.`);
      return;
    }
  }

  const { pages, excluded } = await loadWikiPages(WIKI_DIR);
  console.log(`loaded ${pages.length} routable pages, excluded ${excluded.length}`);
  if (excluded.length > 0) {
    for (const e of excluded) console.log(`  excluded: ${e.path} (${e.reason})`);
  }

  const sample = sampleN(pages, SAMPLE_SIZE, SAMPLE_SEED);
  console.log(`generating ${sample.length} queries via opencode...`);

  const entries = await pMap<WikiPage, QueryEntry>(
    sample,
    async (page) => ({ query: await generateQuery(page), target: page.path }),
    5,
  );

  await Bun.write(QUERIES_PATH, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`wrote ${entries.length} entries to ${QUERIES_PATH}`);
}

await main();
