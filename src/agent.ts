import { AgentDecision, Channel, Env, REQUIRED_FIELDS, Session } from "./types";
import { agentSystemPrompt, packetPrompt } from "./prompts";
import { chatWithFallback, parseJsonLoose } from "./llm";
import { addMessage, logEvent, recentMessages, saveSession } from "./db";
import { retrieveContext } from "./rag";

export interface TurnResult {
  reply: string;
  decision: AgentDecision;
  completedNow: boolean;
  refId: string | null;
}

/**
 * Core agent turn: takes the user's (already text-normalized) input, runs the
 * grounded LLM, merges extracted fields into the session, advances the state
 * machine, and generates the start-of-care packet on completion.
 */
export async function handleTurn(
  env: Env,
  session: Session,
  userText: string,
  channel: Channel,
  kind = "text"
): Promise<TurnResult> {
  session.last_channel = channel;
  await addMessage(env, session.id, "user", channel, kind, userText);

  const ragContext = await retrieveContext(env, userText).catch(() => "");
  const history = await recentMessages(env, session.id);

  const system = agentSystemPrompt({
    agentName: env.AGENT_NAME,
    orgName: env.ORG_NAME,
    session,
    channel,
    ragContext,
  });

  const messages = [
    { role: "system" as const, content: system },
    ...history.map((m) => ({
      role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: m.kind !== "text" && m.role === "user" ? `[via ${m.kind} on ${m.channel}] ${m.content}` : m.content,
    })),
  ];

  const [raw, usedFallback] = await chatWithFallback(env, messages, { json: true });
  if (usedFallback) await logEvent(env, session.id, "llm_fallback", "Groq unavailable — served by OpenRouter fallback");

  let decision: AgentDecision;
  try {
    decision = parseJsonLoose<AgentDecision>(raw);
  } catch (e) {
    decision = {
      reply: "Sorry, could you say that again?",
      field_updates: {},
      user_confirmed: false,
      handoff: false,
      handoff_reason: null,
      guardrail: null,
      language: session.language,
      send_text_request: null,
    };
  }

  // merge extracted fields
  for (const [k, v] of Object.entries(decision.field_updates ?? {})) {
    if (v && typeof v === "string" && v.trim()) session.fields[k] = v.trim();
  }
  if (decision.language) session.language = decision.language;

  // guardrails & handoff
  if (decision.guardrail) {
    await logEvent(env, session.id, "guardrail", decision.guardrail);
  }
  if (decision.handoff) {
    session.status = "handoff";
    await logEvent(env, session.id, "handoff", decision.handoff_reason ?? "escalated to human coordinator");
  }

  // state machine
  const missing = REQUIRED_FIELDS.filter((f) => !session.fields[f]);
  let completedNow = false;
  let refId: string | null = null;

  if (session.status !== "handoff") {
    if (missing.length > 0) {
      session.status = "collecting";
    } else if (decision.user_confirmed) {
      if (session.status !== "complete") {
        completedNow = true;
        session.status = "complete";
        refId = makeRefId(session.id);
        session.packet = await generatePacket(env, session, refId);
        await logEvent(env, session.id, "packet", `Start-of-care packet ${refId} generated`);
      }
    } else {
      session.status = "confirming";
    }
  }

  await addMessage(env, session.id, "agent", channel, "text", decision.reply);
  await saveSession(env, session);

  return { reply: decision.reply, decision, completedNow, refId };
}

function makeRefId(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const tail = digits.slice(-4).padStart(4, "0");
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `CL-${tail}-${rand}`;
}

async function generatePacket(
  env: Env,
  session: Session,
  refId: string
): Promise<Record<string, unknown>> {
  try {
    const [raw] = await chatWithFallback(
      env,
      [{ role: "user", content: packetPrompt(session.fields, refId) }],
      { json: true }
    );
    return parseJsonLoose<Record<string, unknown>>(raw);
  } catch (e) {
    console.error("packet generation failed:", e);
    return { reference_id: refId, patient: session.fields, generated: "fallback" };
  }
}
