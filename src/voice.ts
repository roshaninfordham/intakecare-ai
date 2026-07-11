import { Env } from "./types";
import { getOrCreateSession, logEvent } from "./db";
import { handleTurn } from "./agent";
import { escapeXml, sendMessage, twimlRaw } from "./twilio";

/**
 * TwiML for inbound calls — opens a ConversationRelay WebSocket back to this
 * Worker. Twilio handles STT (Deepgram) + TTS (ElevenLabs); we handle the brain.
 */
export function voiceTwiml(env: Env, host: string, mode: string | null, caller: string): Response {
  if (mode === "gather") return gatherTwiml(env, true);
  const greeting = `Hi! You've reached ${env.ORG_NAME}. I'm ${env.AGENT_NAME}, the intake assistant. I can get care started for you or a loved one in about two minutes. Who do we have the pleasure of helping today?`;
  const wsUrl = `wss://${host}/relay?caller=${encodeURIComponent(caller)}`;
  return twimlRaw(
    `<Response><Connect><ConversationRelay url="${escapeXml(wsUrl)}" welcomeGreeting="${escapeXml(greeting)}" ttsProvider="ElevenLabs" voice="21m00Tcm4TlvDq8ikWAM" transcriptionProvider="Deepgram" speechModel="nova-3-general" interruptible="speech" /></Connect></Response>`
  );
}

/** Fallback voice mode using plain <Gather> — works on any Twilio account. */
export function gatherTwiml(env: Env, greet: boolean): Response {
  const greeting = greet
    ? `<Say voice="Google.en-US-Chirp3-HD-Aoede">Hi! You've reached ${escapeXml(env.ORG_NAME)}. I'm ${escapeXml(env.AGENT_NAME)}, the intake assistant. Who am I helping today?</Say>`
    : "";
  return twimlRaw(
    `<Response>${greeting}<Gather input="speech" action="/gather-turn" method="POST" speechTimeout="auto" language="en-US"/><Redirect method="POST">/voice?mode=gather&amp;greet=0</Redirect></Response>`
  );
}

export async function gatherTurn(env: Env, form: FormData): Promise<Response> {
  const speech = (form.get("SpeechResult") as string) ?? "";
  const from = (form.get("From") as string) ?? "unknown";
  const session = await getOrCreateSession(env, from, "voice");
  if (!speech.trim()) return gatherTwiml(env, false);
  const result = await handleTurn(env, session, speech, "voice", "call");
  if (result.decision.send_text_request) {
    await textCallerForDoc(env, from, result.decision.send_text_request);
  }
  const done = result.decision.handoff || result.completedNow;
  const say = `<Say voice="Google.en-US-Chirp3-HD-Aoede">${escapeXml(result.reply)}</Say>`;
  return twimlRaw(
    done
      ? `<Response>${say}<Hangup/></Response>`
      : `<Response>${say}<Gather input="speech" action="/gather-turn" method="POST" speechTimeout="auto" language="en-US"/><Redirect method="POST">/voice?mode=gather&amp;greet=0</Redirect></Response>`
  );
}

async function textCallerForDoc(env: Env, callerPhone: string, message: string): Promise<void> {
  // Cross-channel moment: mid-call, text the caller on WhatsApp (and SMS if we own a number)
  await sendMessage(env, `whatsapp:${callerPhone}`, env.TWILIO_WHATSAPP_FROM, message);
  if (env.TWILIO_VOICE_FROM) {
    await sendMessage(env, callerPhone, env.TWILIO_VOICE_FROM, message);
  }
  await logEvent(env, callerPhone, "media", `Doc request texted to caller mid-call`);
}

/** ConversationRelay WebSocket handler. */
export function handleRelayUpgrade(env: Env, request: Request): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  server.accept();

  let callerPhone = new URL(request.url).searchParams.get("caller") || "unknown";
  let lastEventId = 0;
  let docPollTimer: ReturnType<typeof setInterval> | null = null;
  let processing = false;

  const speak = (text: string) => {
    server.send(JSON.stringify({ type: "text", token: text, last: true }));
  };

  server.addEventListener("message", (evt) => {
    void (async () => {
      let msg: any;
      try {
        msg = JSON.parse(evt.data as string);
      } catch {
        return;
      }

      if (msg.type === "setup") {
        // prefer a real phone number: query param (browser calls pass it) beats client: identities
        if ((callerPhone === "unknown" || !callerPhone.startsWith("+")) && msg.from?.startsWith("+")) {
          callerPhone = msg.from;
        }
        if (callerPhone === "unknown") callerPhone = msg.from ?? "unknown";
        const session = await getOrCreateSession(env, callerPhone, "voice");
        session.last_channel = "voice";
        await logEvent(env, callerPhone, "system", `Voice call connected (${msg.callSid ?? "?"})`);
        // remember current max event id so the doc-poller only sees new media
        const row = await env.DB.prepare(
          "SELECT COALESCE(MAX(id),0) AS m FROM events WHERE session_id = ?"
        ).bind(callerPhone).first();
        lastEventId = Number((row as any)?.m ?? 0);
        return;
      }

      if (msg.type === "prompt" && msg.voicePrompt) {
        if (processing) return;
        processing = true;
        try {
          const session = await getOrCreateSession(env, callerPhone, "voice");
          const result = await handleTurn(env, session, msg.voicePrompt, "voice", "call");
          speak(result.reply);

          if (result.decision.send_text_request) {
            await textCallerForDoc(env, callerPhone, result.decision.send_text_request);
            // poll for the doc arriving via WhatsApp while the call continues
            if (!docPollTimer) {
              docPollTimer = setInterval(() => {
                void (async () => {
                  const row = await env.DB.prepare(
                    "SELECT id, detail FROM events WHERE session_id = ? AND kind = 'media' AND id > ? AND detail LIKE 'Received%' ORDER BY id DESC LIMIT 1"
                  ).bind(callerPhone, lastEventId).first();
                  if (row) {
                    lastEventId = Number((row as any).id);
                    if (docPollTimer) { clearInterval(docPollTimer); docPollTimer = null; }
                    const session2 = await getOrCreateSession(env, callerPhone, "voice");
                    const r2 = await handleTurn(
                      env,
                      session2,
                      "[system note: the document the caller just sent by text has been processed and its fields merged. Acknowledge it on the call, mention one detail you captured, and continue with the next missing item.]",
                      "voice",
                      "call"
                    );
                    speak(r2.reply);
                  }
                })();
              }, 3000);
            }
          }
          if (result.decision.handoff || result.completedNow) {
            setTimeout(() => {
              try { server.send(JSON.stringify({ type: "end" })); } catch {}
            }, 8000);
          }
        } catch (e) {
          console.error("relay turn error:", e);
          speak("I'm sorry, I had trouble with that. Could you say it again?");
        } finally {
          processing = false;
        }
        return;
      }

      if (msg.type === "error") {
        console.error("relay error:", msg);
      }
    })();
  });

  server.addEventListener("close", () => {
    if (docPollTimer) clearInterval(docPollTimer);
  });

  return new Response(null, { status: 101, webSocket: client });
}
