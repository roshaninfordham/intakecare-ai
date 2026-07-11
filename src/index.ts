import { Hono } from "hono";
import { Channel, Env } from "./types";
import { fetchTwilioMedia, normalizePhone, sendMessage, twimlMessage, twimlMessages } from "./twilio";
import { getOrCreateSession, logEvent, rowToSession } from "./db";
import { handleTurn } from "./agent";
import { extractFromImage, extractFromPdf, transcribeAudio } from "./llm";
import { embed } from "./rag";
import { KNOWLEDGE_DOCS } from "./knowledge";
import { gatherTurn, handleRelayUpgrade, voiceTwiml } from "./voice";
import { voiceAccessToken } from "./token";
import { cancelCalBooking } from "./cal";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Inbound WhatsApp / SMS webhook (Twilio Programmable Messaging)
// Responds instantly with empty TwiML, processes async, replies via REST —
// keeps us far inside Twilio's 15s webhook timeout even for PDFs.
// ---------------------------------------------------------------------------
app.post("/webhook/message", async (c) => {
  const form = await c.req.formData();
  const from = (form.get("From") as string) ?? "";
  const body = ((form.get("Body") as string) ?? "").trim();
  const numMedia = parseInt((form.get("NumMedia") as string) ?? "0", 10);
  const mediaUrl = form.get("MediaUrl0") as string | null;
  const mediaType = (form.get("MediaContentType0") as string) ?? "";
  const { phone, channel } = normalizePhone(from);
  const replyTo = from;
  const replyFrom = channel === "whatsapp" ? c.env.TWILIO_WHATSAPP_FROM : (c.env.TWILIO_VOICE_FROM ?? from);

  // Reply synchronously via TwiML (works even before Twilio KYC approval).
  // If processing outruns the webhook budget, ack now and finish via REST.
  const work = processInbound(c.env, phone, channel, body, numMedia > 0 ? mediaUrl : null, mediaType);
  const timeout = new Promise<null>((res) => setTimeout(() => res(null), 12000));
  const result = await Promise.race([work, timeout]);

  if (result === null) {
    c.executionCtx.waitUntil(
      work.then(async (msgs) => {
        for (const m of msgs) await sendMessage(c.env, replyTo, replyFrom, m);
      })
    );
    return twimlMessage("📄 One sec — still reading that…");
  }
  return twimlMessages(result);
});

async function processInbound(
  env: Env,
  phone: string,
  channel: Channel,
  body: string,
  mediaUrl: string | null,
  mediaType: string
): Promise<string[]> {
  try {
    const session = await getOrCreateSession(env, phone, channel);
    let userText = body;
    let kind = "text";

    if (mediaUrl) {
      const { data, contentType } = await fetchTwilioMedia(env, mediaUrl);
      if (mediaType.startsWith("audio") || contentType.startsWith("audio")) {
        kind = "audio";
        userText = await transcribeAudio(env, data, contentType);
        await logEvent(env, phone, "media", `Received voice note → transcribed (${userText.length} chars)`);
      } else if (contentType.includes("pdf")) {
        kind = "pdf";
        const ex = await extractFromPdf(env, data);
        userText = mediaNote(body, ex.summary, ex.extracted);
        await logEvent(env, phone, "media", `Received PDF → ${ex.summary}`);
      } else if (contentType.startsWith("image")) {
        kind = "image";
        const ex = await extractFromImage(env, data, contentType);
        userText = mediaNote(body, ex.summary, ex.extracted);
        await logEvent(env, phone, "media", `Received image → ${ex.summary}`);
      } else {
        userText = body || "[unsupported attachment]";
      }
    }

    if (!userText.trim()) userText = "[empty message]";
    const result = await handleTurn(env, session, userText, channel, kind);
    const replies = [result.reply];
    if (result.packetNow && result.refId) {
      replies.push(
        `✅ Intake confirmed — reference ${result.refId}.` +
          (result.eligibility ? `\n🛡️ Insurance check: ${result.eligibility.summary}.` : "")
      );
    }
    if (result.bookedNow && result.appointment) {
      const a = result.appointment;
      replies.push(
        `📅 ${result.rescheduledNow ? "Rescheduled" : "Booked"}: ${a.label} with ${a.clinician} (${a.kind === "soc_visit" ? "nurse home visit" : "clinic visit"}, ${a.location}). Reference ${result.refId ?? ""}. It's on the clinic calendar. Please have the insurance card and a list of current medications ready. Reply here anytime to reschedule.`
      );
    }
    return replies;
  } catch (e) {
    console.error("processInbound error:", e);
    await logEvent(env, phone, "system", `error: ${String(e).slice(0, 200)}`);
    return ["Sorry — I hit a snag processing that. Could you try again?"];
  }
}

function mediaNote(body: string, summary: string, extracted: Record<string, string>): string {
  const fields = Object.entries(extracted ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
  return `${body ? body + "\n" : ""}[document received — ${summary}. Extracted fields: ${fields || "none"}. Confirm these with me naturally and continue.]`;
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------
app.post("/voice", async (c) => {
  const form = await c.req.formData().catch(() => new FormData());
  // browser calls pass ?phone= via connect params; PSTN calls use From
  const phoneParam = (form.get("phone") as string) ?? "";
  const from = (form.get("From") as string) ?? "";
  const caller = phoneParam.startsWith("+")
    ? phoneParam
    : from.startsWith("+")
      ? from
      : from || "unknown";
  return voiceTwiml(c.env, new URL(c.req.url).host, c.req.query("mode") ?? null, caller);
});
app.get("/voice", (c) => voiceTwiml(c.env, new URL(c.req.url).host, c.req.query("mode") ?? null, "unknown"));
app.post("/gather-turn", async (c) => gatherTurn(c.env, await c.req.formData()));

// Access token for browser (WebRTC) calls from the dashboard
app.get("/api/voice-token", async (c) => {
  const token = await voiceAccessToken(c.env, "dashboard-" + Math.floor(Math.random() * 10000));
  return c.json({ token });
});

// ---------------------------------------------------------------------------
// Dashboard API
// ---------------------------------------------------------------------------
app.get("/api/sessions", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 20"
  ).all();
  return c.json((results as any[]).map(rowToSession));
});

app.get("/api/sessions/:id", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
  if (!row) return c.json({ error: "not found" }, 404);
  const { results: msgs } = await c.env.DB.prepare(
    "SELECT role, channel, kind, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 200"
  ).bind(id).all();
  const { results: evts } = await c.env.DB.prepare(
    "SELECT kind, detail, created_at FROM events WHERE session_id = ? ORDER BY id ASC LIMIT 200"
  ).bind(id).all();
  const { results: appts } = await c.env.DB.prepare(
    "SELECT ref_id, patient_name, label, kind, clinician, location, cal_uid, created_at FROM appointments WHERE session_id = ? ORDER BY id DESC"
  ).bind(id).all();
  return c.json({ session: rowToSession(row as any), messages: msgs, events: evts, appointments: appts });
});

app.get("/api/appointments", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT session_id, ref_id, patient_name, label, kind, clinician, location, cal_uid, created_at FROM appointments ORDER BY id DESC LIMIT 20"
  ).all();
  return c.json(results);
});

app.get("/api/events", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT session_id, kind, detail, created_at FROM events ORDER BY id DESC LIMIT 50"
  ).all();
  return c.json(results);
});

// ---------------------------------------------------------------------------
// Admin: seed knowledge + reset a session for re-demo
// ---------------------------------------------------------------------------
app.post("/admin/seed", async (c) => {
  if (c.req.header("x-admin-key") !== c.env.ADMIN_KEY) return c.text("nope", 401);

  // clinic calendar: open slots over the next 3 days (synthetic)
  await c.env.DB.prepare("DELETE FROM slots WHERE booked = 0").run();
  const clinicians = [
    ["Maria G., RN", "soc_visit", "patient's home"],
    ["Wei L., RN", "soc_visit", "patient's home"],
    ["Olga K., RN (wound care)", "soc_visit", "patient's home"],
    ["Dr. Sarah Chen, Cardiology", "clinic_followup", "CareLine Partner Clinic, 200 W 57th St"],
  ];
  const hours = [9, 11, 14, 16];
  let n = 0;
  for (let day = 1; day <= 3; day++) {
    for (const h of hours) {
      // clinic-local (ET) slot times; store as naive local, label matches what the clinic sees
      const dt = new Date(Date.now() + day * 86400000);
      dt.setUTCHours(h + 4, 0, 0, 0); // ET (EDT) → UTC
      const [clin, kind, loc] = clinicians[n % clinicians.length];
      const label = dt.toLocaleString("en-US", {
        weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
      });
      await c.env.DB.prepare(
        "INSERT INTO slots (start_ts, label, kind, clinician, location) VALUES (?,?,?,?,?)"
      ).bind(dt.toISOString(), label, kind, clin, loc).run();
      n++;
    }
  }

  await c.env.DB.prepare("DELETE FROM knowledge").run();
  let embedded = 0;
  let vectors: number[][] | null = null;
  try {
    vectors = await embed(c.env, KNOWLEDGE_DOCS.map((d) => `${d.title}: ${d.chunk}`));
  } catch (e) {
    console.error("embedding failed at seed; keyword fallback will be used", e);
  }
  for (let i = 0; i < KNOWLEDGE_DOCS.length; i++) {
    const d = KNOWLEDGE_DOCS[i];
    await c.env.DB.prepare("INSERT INTO knowledge (title, chunk, embedding) VALUES (?, ?, ?)")
      .bind(d.title, d.chunk, vectors ? JSON.stringify(vectors[i]) : null)
      .run();
    if (vectors) embedded++;
  }
  return c.json({ seeded: KNOWLEDGE_DOCS.length, embedded, slots: n });
});

// Outbound proactive call (goes live once Twilio KYC/Trust Hub is approved + a number is owned)
app.post("/admin/call", async (c) => {
  if (c.req.header("x-admin-key") !== c.env.ADMIN_KEY) return c.text("nope", 401);
  const phone = c.req.query("phone");
  if (!phone) return c.text("phone query param required", 400);
  if (!c.env.TWILIO_VOICE_FROM) {
    return c.json({ error: "No Twilio voice number owned yet — complete Trust Hub KYC, buy a number, set TWILIO_VOICE_FROM." }, 409);
  }
  const host = new URL(c.req.url).host;
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${c.env.TWILIO_ACCOUNT_SID}/Calls.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${c.env.TWILIO_API_KEY_SID}:${c.env.TWILIO_API_KEY_SECRET}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: phone, From: c.env.TWILIO_VOICE_FROM, Url: `https://${host}/voice`, Method: "POST" }),
    }
  );
  return c.json(await res.json() as any, res.ok ? 200 : 502);
});

app.post("/admin/reset", async (c) => {
  if (c.req.header("x-admin-key") !== c.env.ADMIN_KEY) return c.text("nope", 401);
  const phone = c.req.query("phone");
  if (!phone) return c.text("phone query param required", 400);
  const { results: bookings } = await c.env.DB.prepare(
    "SELECT cal_uid FROM appointments WHERE session_id = ? AND cal_uid IS NOT NULL"
  ).bind(phone).all();
  for (const b of bookings as { cal_uid: string }[]) {
    await cancelCalBooking(c.env, b.cal_uid).catch((e) => console.error("cal cancel failed:", e));
  }
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(phone).run();
  await c.env.DB.prepare("DELETE FROM messages WHERE session_id = ?").bind(phone).run();
  await c.env.DB.prepare("DELETE FROM events WHERE session_id = ?").bind(phone).run();
  await c.env.DB.prepare("UPDATE slots SET booked = 0, booked_by = NULL WHERE booked_by = ?").bind(phone).run();
  await c.env.DB.prepare("DELETE FROM appointments WHERE session_id = ?").bind(phone).run();
  return c.json({ reset: phone, cal_cancelled: bookings.length });
});

app.get("/health", (c) => c.json({ ok: true, service: "careline-ai" }));

// ---------------------------------------------------------------------------
// Export: raw fetch handles the WebSocket upgrade before Hono
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/relay") {
      return handleRelayUpgrade(env, request);
    }
    return app.fetch(request, env, ctx);
  },
};
