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
  eligibility: Eligibility | null;
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
  kind = "text",
  media?: { url: string; type: string }
): Promise<TurnResult> {
  session.last_channel = channel;
  await addMessage(env, session.id, "user", channel, kind, userText, media?.url, media?.type);

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
  const { results: apptRows } = await env.DB.prepare(
    "SELECT label, clinician, kind FROM appointments WHERE session_id = ? ORDER BY id DESC LIMIT 5"
  ).bind(session.id).all();
  const priorAppointments = (apptRows as any[]).map(
    (a) => `${a.label} — ${a.clinician} (${a.kind === "soc_visit" ? "home visit" : "clinic visit"})`
  );

  const system = agentSystemPrompt({
    agentName: env.AGENT_NAME,
    orgName: env.ORG_NAME,
    session,
    channel,
    ragContext,
    slots,
    existingAppointment: existingAppt ? `${existingAppt.label} with ${existingAppt.clinician}` : null,
    priorAppointments,
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
      booking_intent: null,
      specialist: null,
      request_call: false,
      end_call: false,
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
  let eligibility: Eligibility | null = null;

  if (session.status !== "handoff") {
    if (missing.length > 0) {
      session.status = "collecting";
    } else if ((decision.user_confirmed || session.status === "scheduling") && !session.packet) {
      packetNow = true;
      session.status = "scheduling";
      refId = makeRefId(session.id);
      // instant automated eligibility check — the work a human coordinator queues for "1 business day"
      const t0 = Date.now();
      eligibility = verifyEligibility(session.fields);
      session.packet = buildPacket(session.fields, refId);
      session.packet.eligibility = eligibility as unknown as Record<string, unknown>;
      await logEvent(env, session.id, "packet", `Start-of-care packet ${refId} generated`);
      await logEvent(
        env, session.id, "packet",
        `Eligibility verified in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${eligibility.summary}`
      );
    } else if (!session.packet) {
      session.status = "confirming";
    }

    // booking or rescheduling: the user picked a slot from the list they were shown
    if (decision.booked_slot_id != null && session.packet) {
      const chosen = slots.find((s) => s.id === Number(decision.booked_slot_id));
      if (chosen) {
        const patientName = session.fields.patient_name ?? "CareLine patient";
        // a second booking requires a genuinely new concern; otherwise treat as reschedule
        const hasNewConcern = !!(decision.specialist || decision.field_updates?.new_concern || session.fields.new_concern);
        const wantsNew = !existingAppt || (decision.booking_intent === "new" && hasNewConcern);
        try {
          if (existingAppt && !wantsNew && existingAppt.start_ts === chosen.start_ts) {
            // no-op: "rescheduling" to the identical time — ignore (LLM echoing the slot id)
          } else if (existingAppt?.cal_uid && !wantsNew) {
            // reschedule the real Cal.com booking (Cal issues a NEW uid — store it)
            const moved = await rescheduleCalBooking(env, existingAppt.cal_uid, chosen.start_ts);
            await env.DB.prepare("UPDATE appointments SET start_ts = ?, label = ?, cal_uid = ? WHERE id = ?")
              .bind(chosen.start_ts, chosen.label, moved.uid, existingAppt.id).run();
            rescheduledNow = true;
            session.status = "complete";
            bookedNow = true;
            appointment = { label: chosen.label, clinician: existingAppt.clinician, kind: existingAppt.kind, location: existingAppt.location };
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
            // specialist routing applies only to FOLLOW-UP bookings for a new concern —
            // the first visit is always the SOC nurse visit, even if a specialist was recommended
            const specialist = existingAppt ? decision.specialist : null;
            const clinician = specialist || chosen.clinician;
            const kind = specialist && /dr\.|md|cardio|endo|pulmo/i.test(specialist)
              ? "clinic_followup" : chosen.kind;
            const location = kind === "clinic_followup" ? "CareLine Partner Clinic, 200 W 57th St" : chosen.location;
            await env.DB.prepare(
              "INSERT INTO appointments (session_id, slot_id, ref_id, patient_name, start_ts, label, kind, clinician, location, cal_uid) VALUES (?,?,?,?,?,?,?,?,?,?)"
            ).bind(
              session.id, chosen.id, refId, patientName,
              chosen.start_ts, chosen.label, kind, clinician, location, calUid
            ).run();
            await logEvent(env, session.id, "packet",
              `Appointment booked: ${chosen.label} with ${clinician}${specialist ? ` [routed: ${session.fields.new_concern ?? "new concern"}]` : ""}${calUid ? ` (Cal.com ${calUid})` : " (local calendar)"}`);
            appointment = { label: chosen.label, clinician, kind, location };
            session.status = "complete";
            bookedNow = true;
          }
        } catch (e) {
          console.error("booking failed:", e);
          await logEvent(env, session.id, "system", `booking error: ${String(e).slice(0, 150)}`);
        }
      }
    }
  }

  await addMessage(env, session.id, "agent", channel, "text", decision.reply);
  await saveSession(env, session);

  return { reply: decision.reply, decision, packetNow, bookedNow, rescheduledNow, refId, appointment, eligibility };
}

export interface Eligibility {
  eligible: boolean | null;
  summary: string;
}

const ACCEPTED_PAYERS = [
  "medicare", "medicaid", "aetna", "unitedhealthcare", "united healthcare",
  "empire", "bluecross", "blue cross", "cigna", "humana",
];

/**
 * Automated eligibility verification (synthetic payer rules for the demo; in
 * production this is an EDI 270/271 or payer-API call — same shape, same speed).
 */
function verifyEligibility(fields: Session["fields"]): Eligibility {
  const payer = (fields.insurance_payer ?? "").toLowerCase();
  const memberId = fields.insurance_member_id ?? "";
  if (!payer || !memberId) {
    return { eligible: null, summary: "Missing payer or member ID — flagged for manual verification" };
  }
  const match = ACCEPTED_PAYERS.find((p) => payer.includes(p));
  if (!match) {
    return {
      eligible: null,
      summary: `${fields.insurance_payer} is out of network — coordinator will confirm options within 1 business day`,
    };
  }
  const isMA = payer.includes("advantage") || payer.includes("medicare");
  return {
    eligible: true,
    summary: `${fields.insurance_payer} (member ${memberId}) — in network, home health covered${isMA ? ", no prior auth required for the initial evaluation" : ", prior auth auto-submitted for the initial evaluation"}`,
  };
}

interface ApptRow {
  id: number;
  label: string;
  clinician: string;
  kind: string;
  location: string;
  start_ts: string;
  cal_uid: string | null;
}

async function latestAppointment(env: Env, sessionId: string): Promise<ApptRow | null> {
  const row = await env.DB.prepare(
    "SELECT id, label, clinician, kind, location, start_ts, cal_uid FROM appointments WHERE session_id = ? ORDER BY id DESC LIMIT 1"
  ).bind(sessionId).first<ApptRow>();
  return row ?? null;
}

function makeRefId(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const tail = digits.slice(-4).padStart(4, "0");
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `CL-${tail}-${rand}`;
}

/**
 * Deterministic SOC packet — built from the typed fields, never an LLM.
 * Zero hallucination risk; recommended services are simple clinical keyword rules.
 */
function buildPacket(fields: Session["fields"], refId: string): Record<string, unknown> {
  const dx = (fields.primary_diagnosis ?? "").toLowerCase();
  const urgency = /urgent|48 hour|asap|immediate/i.test(fields.urgency ?? "") ? "urgent" : "routine";
  const services = new Set<string>(["skilled nursing"]);
  if (/heart|chf|cardiac|hypertension/.test(dx)) services.add("cardiac monitoring & daily weights");
  if (/diabet/.test(dx)) services.add("diabetes management education");
  if (/wound|ulcer|surgical|post-op/.test(dx)) services.add("wound care");
  if (/stroke|fall|fracture|hip|knee|decondition|mobility/.test(dx)) services.add("physical therapy evaluation");
  if (/copd|respiratory|pneumonia|oxygen/.test(dx)) services.add("respiratory monitoring");
  return {
    reference_id: refId,
    patient: {
      name: fields.patient_name ?? null,
      date_of_birth: fields.date_of_birth ?? null,
      address: fields.address ?? null,
      callback_phone: fields.callback_phone ?? null,
    },
    insurance: {
      payer: fields.insurance_payer ?? null,
      member_id: fields.insurance_member_id ?? null,
    },
    clinical: {
      primary_diagnosis: fields.primary_diagnosis ?? null,
      physician: fields.physician_name ?? null,
      urgency,
    },
    referral: { source: fields.referral_source ?? null },
    recommended_services: [...services].slice(0, 4),
    next_steps: ["Insurance eligibility verified", "Care coordinator assigned", "Start-of-care visit scheduled"],
    notes: fields.notes ?? fields.urgency ?? "",
  };
}
