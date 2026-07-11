import { Env } from "./types";
import { addMessage, getOrCreateSession, logEvent, saveSession } from "./db";
import { handleTurn } from "./agent";
import { escapeXml, sendMessage, twimlRaw } from "./twilio";

/** BCP-47 tags for the languages configured in the TwiML below (must stay in sync). */
const LANG_TAGS: Record<string, string> = {
  en: "en-US",
  es: "es-US",
  hi: "hi-IN",
  fr: "fr-FR",
  pt: "pt-BR",
};

// Amelia (warm conversational) on flash v2.5 — speed 1.0, lower stability for
// natural expressiveness, per Twilio's voiceId-model-speed_stability_similarity syntax
const ELEVENLABS_VOICE = "ZF6FPAbjXT4488VcRRnw-flash_v2_5-1.0_0.5_0.75";

function greetingText(env: Env, patientName?: string | null): string {
  if (patientName) {
    const first = patientName.split(/\s+/)[0];
    return `Hi, welcome back to ${env.ORG_NAME}! This is ${env.AGENT_NAME}. I have ${first}'s file right here — what can I help with today?`;
  }
  return `Hi, you've reached ${env.ORG_NAME}. This is ${env.AGENT_NAME}. I can get care started for you or a loved one in a couple of minutes — who am I helping today?`;
}

/**
 * TwiML for inbound calls — opens a ConversationRelay WebSocket back to this
 * Worker. Deepgram nova-3 "multi" auto-detects the caller's language; each
 * reply is tagged with its language so ElevenLabs speaks it natively.
 */
export async function voiceTwiml(env: Env, host: string, mode: string | null, caller: string): Promise<Response> {
  if (mode === "gather") return gatherTwiml(env, true);
  // caller recognition: returning patients get greeted by name
  let patientName: string | null = null;
  if (caller.startsWith("+")) {
    const row = await env.DB.prepare("SELECT fields FROM sessions WHERE id = ?").bind(caller).first();
    if (row) patientName = (JSON.parse((row as any).fields || "{}").patient_name as string) ?? null;
  }
  const wsUrl = `wss://${host}/relay?caller=${encodeURIComponent(caller)}`;
  const langs = Object.values(LANG_TAGS)
    .map((code) => `<Language code="${code}" ttsProvider="ElevenLabs" voice="${ELEVENLABS_VOICE}"/>`)
    .join("");
  return twimlRaw(
    `<Response><Connect><ConversationRelay url="${escapeXml(wsUrl)}" welcomeGreeting="${escapeXml(greetingText(env, patientName))}" ttsProvider="ElevenLabs" voice="${ELEVENLABS_VOICE}" transcriptionProvider="Deepgram" speechModel="nova-3-general" transcriptionLanguage="multi" interruptible="any" reportInputDuringAgentSpeech="none">${langs}</ConversationRelay></Connect></Response>`
  );
}

/** Fallback voice mode using plain <Gather> — works on any Twilio account. */
export function gatherTwiml(env: Env, greet: boolean): Response {
  const greeting = greet
    ? `<Say voice="Google.en-US-Chirp3-HD-Aoede">${escapeXml(greetingText(env))}</Say>`
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
  const done = result.decision.handoff || result.bookedNow;
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

  const reqUrl = new URL(request.url);
  const typingSound = `https://${reqUrl.host}/demo/typing.wav`;
  let callerPhone = reqUrl.searchParams.get("caller") || "unknown";
  let lastEventId = 0;
  let currentLang = "en-US";
  let docPollTimer: ReturnType<typeof setInterval> | null = null;
  let processing = false;

  const speak = (text: string, langCode?: string) => {
    const lang = langCode && Object.values(LANG_TAGS).includes(langCode) ? langCode : currentLang;
    server.send(JSON.stringify({ type: "text", token: text, last: true, lang }));
  };

  const runTurn = async (input: string) => {
    server.send(JSON.stringify({ type: "play", source: typingSound, loop: 1, preemptible: true, interruptible: true }));
    const session = await getOrCreateSession(env, callerPhone, "voice");
    const result = await handleTurn(env, session, input, "voice", "call");
    const lang = LANG_TAGS[result.decision.language] ?? currentLang;
    currentLang = lang;
    speak(result.reply, lang);
    if (result.decision.send_text_request) {
      await textCallerForDoc(env, callerPhone, result.decision.send_text_request);
    }
    // end only on explicit goodbye or a human handoff — never yank the call after a booking
    if (result.decision.handoff || (result.decision as any).end_call) {
      setTimeout(() => {
        try { server.send(JSON.stringify({ type: "end" })); } catch {}
      }, 9000);
    }
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
        if ((callerPhone === "unknown" || !callerPhone.startsWith("+")) && msg.from?.startsWith("+")) {
          callerPhone = msg.from;
        }
        if (callerPhone === "unknown") callerPhone = msg.from ?? "unknown";
        const session = await getOrCreateSession(env, callerPhone, "voice");
        session.last_channel = "voice";
        session.awaiting_doc = 1; // any doc sent over WhatsApp during the call gets acknowledged on the call
        await saveSession(env, session);
        // record the spoken greeting so the agent never re-introduces itself
        await addMessage(env, callerPhone, "agent", "voice", "text", greetingText(env, session.fields.patient_name));
        await logEvent(env, callerPhone, "system", `Voice call connected (${msg.callSid ?? "?"})`);
        const row = await env.DB.prepare(
          "SELECT COALESCE(MAX(id),0) AS m FROM events WHERE session_id = ?"
        ).bind(callerPhone).first();
        lastEventId = Number((row as any)?.m ?? 0);

        // watch for documents arriving on WhatsApp for the whole call
        docPollTimer = setInterval(() => {
          void (async () => {
            if (processing) return;
            const row2 = await env.DB.prepare(
              "SELECT id FROM events WHERE session_id = ? AND kind = 'media' AND id > ? AND detail LIKE 'Received%' ORDER BY id DESC LIMIT 1"
            ).bind(callerPhone, lastEventId).first();
            if (row2) {
              lastEventId = Number((row2 as any).id);
              processing = true;
              try {
                await runTurn(
                  "[system note: the caller's document just arrived by WhatsApp and its fields are merged. In ONE short sentence, acknowledge it naturally, mention one detail you captured, then ask the next missing item — or move to scheduling if nothing is missing.]"
                );
              } finally {
                processing = false;
              }
            }
          })();
        }, 2500);
        return;
      }

      if (msg.type === "prompt" && msg.voicePrompt) {
        if (processing) return;
        processing = true;
        try {
          await runTurn(msg.voicePrompt);
        } catch (e) {
          console.error("relay turn error:", e);
          speak("Sorry, I missed that — could you say it once more?");
        } finally {
          processing = false;
        }
        return;
      }

      if (msg.type === "error") {
        console.error("relay error:", JSON.stringify(msg).slice(0, 300));
      }
    })();
  });

  server.addEventListener("close", () => {
    if (docPollTimer) clearInterval(docPollTimer);
    void (async () => {
      const session = await getOrCreateSession(env, callerPhone, "voice");
      session.awaiting_doc = 0;
      await saveSession(env, session);
    })();
  });

  return new Response(null, { status: 101, webSocket: client });
}
