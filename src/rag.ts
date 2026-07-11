import { Env } from "./types";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const res = (await env.AI.run(EMBED_MODEL, { text: texts })) as { data: number[][] };
  return res.data;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Retrieve top-k knowledge chunks for a query.
 * Embedding-based (Workers AI) with keyword fallback if embeddings unavailable.
 */
export async function retrieveContext(env: Env, query: string, k = 3): Promise<string> {
  const { results } = await env.DB.prepare("SELECT title, chunk, embedding FROM knowledge").all();
  const rows = results as { title: string; chunk: string; embedding: string | null }[];
  if (!rows.length) return "";

  try {
    const [qv] = await embed(env, [query.slice(0, 1000)]);
    const scored = rows
      .filter((r) => r.embedding)
      .map((r) => ({ ...r, score: cosine(qv, JSON.parse(r.embedding!)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    if (scored.length) {
      return scored.map((r) => `### ${r.title}\n${r.chunk}`).join("\n\n");
    }
  } catch (e) {
    console.error("embedding retrieval failed, keyword fallback:", e);
  }

  // keyword fallback
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const scored = rows
    .map((r) => ({
      ...r,
      score: words.filter((w) => (r.title + " " + r.chunk).toLowerCase().includes(w)).length,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored.map((r) => `### ${r.title}\n${r.chunk}`).join("\n\n");
}
