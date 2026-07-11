import { AgentDecision, Channel, Env, REQUIRED_FIELDS, Session, Slot } from "./types";
import { agentSystemPrompt, packetPrompt } from "./prompts";
import { chatWithFallback, parseJsonLoose } from "./llm";
import { addMessage, logEvent, recentMessages, saveSession } from "./db";
import { retrieveContext } from "./rag";
import { createCalBooking, getCalSlots, rescheduleCalBooking } from "./cal";

export interface TurnResult {
  reply: string;
  decision: AgentDecision;
  packetNow: boolean; // intake confirmed + SOC packet generated this turn
  bookedNow: boolean; // appointment booked (or rescheduled) this turn
  rescheduledNow: boolean;
  refId: string | null;
  appointment: { label: string; clinician: string; kind: string; location: string } | null;
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

  // when all required fields are in, the agent gets the live clinic calendar
  // (Cal.com is the source of truth; the local D1 calendar is the fallback)
  const missingBefore = REQUIRED_FIELDS.filter((f) => !session.fields[f]);
  let slots: Slot[] = [];
  let slotsSource: "cal" | "local" = "cal";
  if (missingBefore.length === 0) {
    try {
      slots = await getCalSlots(env);
    } catch (e) {
      console.error("cal.com slots failed, using local calendar:", e);
      slotsSource = "local";
      const { results } = await env.DB.prepare(
        "SELECT id, start_ts, label, kind, clinician, location FROM slots WHERE booked = 0 ORDER BY start_ts ASC LIMIT 6"
      ).all();
      slots = results as unknown as Slot[];
    }
  }

  const existingAppt = await latestAppointment(env, session.id);

  const system = agentSystemPrompt({
    agentName: env.AGENT_NAME,
    orgName: env.ORG_NAME,
    session,
    channel,
    ragContext,
    slots,
    existingAppointment: existingAppt ? `${existingAppt.label} with ${existingAppt.clinician}` : null,
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
      booked_slot_id: null,
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
  let packetNow = false;
  let bookedNow = false;
  let rescheduledNow = false;
  let refId: string | null = (session.packet?.reference_id as string) ?? null;
  let appointment: TurnResult["appointment"] = null;

  if (session.status !== "handoff") {
    if (missing.length > 0) {
      session.status = "collecting";
    } else if ((decision.user_confirmed || session.status === "scheduling") && !session.packet) {
      packetNow = true;
      session.status = "scheduling";
      refId = makeRefId(session.id);
      session.packet = await generatePacket(env, session, refId);
      await logEvent(env, session.id, "packet", `Start-of-care packet ${refId} generated`);
    } else if (!session.packet) {
      session.status = "confirming";
    }

    // booking or rescheduling: the user picked a slot from the list they were shown
    if (decision.booked_slot_id != null && session.packet) {
      const chosen = slots.find((s) => s.id === Number(decision.booked_slot_id));
      if (chosen) {
        const patientName = session.fields.patient_name ?? "CareLine patient";
        try {
          if (existingAppt?.cal_uid) {
            // reschedule the real Cal.com booking
            await rescheduleCalBooking(env, existingAppt.cal_uid, chosen.start_ts);
            await env.DB.prepare("UPDATE appointments SET start_ts = ?, label = ? WHERE id = ?")
              .bind(chosen.start_ts, chosen.label, existingAppt.id).run();
            rescheduledNow = true;
            await logEvent(env, session.id, "packet", `Appointment rescheduled to ${chosen.label} (Cal.com ${existingAppt.cal_uid})`);
          } else {
            let calUid: string | null = null;
            if (slotsSource === "cal") {
              const booking = await createCalBooking(
                env, chosen.start_ts, patientName, session.id, session.fields.email
              );
              calUid = booking.uid;
            } else {
              await env.DB.prepare("UPDATE slots SET booked = 1, booked_by = ? WHERE id = ?")
                .bind(session.id, chosen.id).run();
            }
            await env.DB.prepare(
              "INSERT INTO appointments (session_id, slot_id, ref_id, patient_name, start_ts, label, kind, clinician, location, cal_uid) VALUES (?,?,?,?,?,?,?,?,?,?)"
            ).bind(
              session.id, chosen.id, refId, patientName,
              chosen.start_ts, chosen.label, chosen.kind, chosen.clinician, chosen.location, calUid
            ).run();
            await logEvent(env, session.id, "packet",
              `Appointment booked: ${chosen.label} with ${chosen.clinician}${calUid ? ` (Cal.com ${calUid})` : " (local calendar)"}`);
          }
          session.status = "complete";
          bookedNow = true;
          appointment = { label: chosen.label, clinician: chosen.clinician, kind: chosen.kind, location: chosen.location };
        } catch (e) {
          console.error("booking failed:", e);
          await logEvent(env, session.id, "system", `booking error: ${String(e).slice(0, 150)}`);
        }
      }
    }
  }

  await addMessage(env, session.id, "agent", channel, "text", decision.reply);
  await saveSession(env, session);

  return { reply: decision.reply, decision, packetNow, bookedNow, rescheduledNow, refId, appointment };
}

interface ApptRow {
  id: number;
  label: string;
  clinician: string;
  cal_uid: string | null;
}

async function latestAppointment(env: Env, sessionId: string): Promise<ApptRow | null> {
  const row = await env.DB.prepare(
    "SELECT id, label, clinician, cal_uid FROM appointments WHERE session_id = ? ORDER BY id DESC LIMIT 1"
  ).bind(sessionId).first<ApptRow>();
  return row ?? null;
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
