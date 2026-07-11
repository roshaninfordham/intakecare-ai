import { Buffer } from "node:buffer";
import { Env } from "./types";
import { MEDIA_EXTRACT_PROMPT } from "./prompts";

const GROQ_BASE = "https://api.groq.com/openai/v1";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export const GROQ_CHAT_MODEL = "llama-3.3-70b-versatile";
export const GROQ_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
export const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";
export const OPENROUTER_FALLBACK_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
export const OPENROUTER_PDF_MODEL = "google/gemini-2.0-flash-exp:free";

type ChatMessage = { role: "system" | "user" | "assistant"; content: unknown };

async function groqChat(
  env: Env,
  messages: ChatMessage[],
  opts: { model?: string; json?: boolean; maxTokens?: number } = {}
): Promise<string> {
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model ?? GROQ_CHAT_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`groq ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.choices[0].message.content as string;
}

async function openrouterChat(
  env: Env,
  messages: ChatMessage[],
  opts: { model?: string; json?: boolean; maxTokens?: number; plugins?: unknown[] } = {}
): Promise<string> {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://careline-ai.workers.dev",
      "X-Title": "CareLine AI",
    },
    body: JSON.stringify({
      model: opts.model ?? OPENROUTER_FALLBACK_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.plugins ? { plugins: opts.plugins } : {}),
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.choices[0].message.content as string;
}

/** Primary chat with automatic Groq -> OpenRouter fallback. Returns [text, usedFallback]. */
export async function chatWithFallback(
  env: Env,
  messages: ChatMessage[],
  opts: { json?: boolean; maxTokens?: number } = {}
): Promise<[string, boolean]> {
  try {
    return [await groqChat(env, messages, opts), false];
  } catch (e) {
    console.error("groq failed, falling back to openrouter:", e);
    return [await openrouterChat(env, messages, opts), true];
  }
}

export function parseJsonLoose<T>(text: string): T {
  // strip markdown fences and grab the outermost JSON object
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`no JSON in: ${text.slice(0, 200)}`);
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

/** Transcribe audio (any language) with Groq Whisper. */
export async function transcribeAudio(
  env: Env,
  audio: ArrayBuffer,
  contentType: string
): Promise<string> {
  const ext = contentType.includes("ogg")
    ? "ogg"
    : contentType.includes("mp4") || contentType.includes("m4a")
      ? "m4a"
      : contentType.includes("mpeg")
        ? "mp3"
        : "wav";
  const form = new FormData();
  form.append("file", new File([audio], `note.${ext}`, { type: contentType }));
  form.append("model", GROQ_WHISPER_MODEL);
  form.append("response_format", "json");
  const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.text as string;
}

export interface MediaExtraction {
  summary: string;
  extracted: Record<string, string>;
}

/** Read an image (insurance card, referral photo) with Groq's Llama-4 Scout vision. */
export async function extractFromImage(
  env: Env,
  image: ArrayBuffer,
  contentType: string
): Promise<MediaExtraction> {
  const b64 = Buffer.from(image).toString("base64");
  const content = [
    { type: "text", text: MEDIA_EXTRACT_PROMPT },
    { type: "image_url", image_url: { url: `data:${contentType};base64,${b64}` } },
  ];
  try {
    const text = await groqChat(env, [{ role: "user", content }], {
      model: GROQ_VISION_MODEL,
      json: true,
    });
    return parseJsonLoose<MediaExtraction>(text);
  } catch (e) {
    console.error("scout vision failed, trying openrouter:", e);
    const text = await openrouterChat(env, [{ role: "user", content }], {
      model: OPENROUTER_PDF_MODEL,
    });
    return parseJsonLoose<MediaExtraction>(text);
  }
}

/** Read a PDF (referral packet): Workers AI toMarkdown extracts text, Groq structures it. */
export async function extractFromPdf(env: Env, pdf: ArrayBuffer): Promise<MediaExtraction> {
  const results = await env.AI.toMarkdown([
    { name: "referral.pdf", blob: new Blob([pdf], { type: "application/pdf" }) },
  ]);
  const first = (Array.isArray(results) ? results[0] : results) as any;
  const markdown: string = first?.format !== "error" ? (first?.data ?? "") : "";
  if (!markdown.trim()) {
    return {
      summary: "a PDF I couldn't read (it may be a scanned image — a photo of the page works better)",
      extracted: {},
    };
  }
  const [text] = await chatWithFallback(
    env,
    [{ role: "user", content: `${MEDIA_EXTRACT_PROMPT}\n\nDocument text:\n${markdown.slice(0, 8000)}` }],
    { json: true }
  );
  return parseJsonLoose<MediaExtraction>(text);
}
