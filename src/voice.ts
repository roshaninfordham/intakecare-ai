import { Env } from "./types";
import { addMessage, getOrCreateSession, logEvent, saveSession } from "./db";
import { handleTurn } from "./agent";
import { escapeXml, sendMessage, twimlRaw } from "./twilio";

/**
 * ISO 639-1 → BCP-47, one entry per <Language> element in the TwiML.
 * The first ten are the languages Deepgram's nova-3 `multi` model transcribes
 * live (auto-detected, code-switchable). ElevenLabs flash_v2_5 speaks all of
 * these — plus Chinese, which Deepgram `multi` can't hear, so `zh` is handled
 * as an explicit per-call transcription switch (see initialTranscription()).
 */
const LANG_TAGS: Record<string, string> = {
  en: "en-US",
  es: "es-US",
  fr: "fr-FR",
  de: "de-DE",
  hi: "hi-IN",
  it: "it-IT",
  ja: "ja-JP",
  nl: "nl-NL",
  ru: "ru-RU",
  pt: "pt-BR",
  zh: "zh-CN",
};

/** Languages Deepgram nova-3 `multi` transcribes live (no Chinese). */
const MULTI_LANGS = new Set(["en", "es", "fr", "de", "hi", "it", "ja", "nl", "ru", "pt"]);

/** Short native greetings for callers we already know prefer a non-English language. */
const GREETINGS: Record<string, (org: string, name: string) => string> = {
  zh: (org, name) => `您好，欢迎致电${org}，我是${name}。请问今天需要什么帮助？`,
  es: (org, name) => `Hola, le habla ${name} de ${org}. ¿En qué puedo ayudarle hoy?`,
  hi: (org, name) => `नमस्ते, ${org} में आपका स्वागत है। मैं ${name} हूँ। मैं आपकी कैसे मदद कर सकती हूँ?`,
};

// Jessica — natural American English conversational female, flash v2.5,
// lower stability for expressiveness (voiceId-model-speed_stability_similarity)
const ELEVENLABS_VOICE = "cgSgspJ2msm6clMCkdW9-flash_v2_5-1.0_0.5_0.75";

/**
 * Which transcription language to open the call with. `multi` auto-detects the
 * 10 Deepgram languages; a caller already known to speak Chinese (e.g. from a
 * prior WhatsApp chat) opens directly in Chinese STT so the call works.
 */
function initialTranscription(sessionLang: string | undefined): string {
  if (sessionLang && LANG_TAGS[sessionLang] && !MULTI_LANGS.has(sessionLang)) return sessionLang;
  return "multi";
}

function greetingText(env: Env, patientName?: string | null, lang?: string): string {
  // known non-English caller → greet natively
  if (lang && lang !== "en" && GREETINGS[lang]) {
    return GREETINGS[lang](env.ORG_NAME, env.AGENT_NAME);
  }
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
  // caller recognition: returning patients get greeted by name, in their language
  let patientName: string | null = null;
  let sessionLang: string | undefined;
  if (caller.startsWith("+")) {
    const row = await env.DB.prepare("SELECT fields, language FROM sessions WHERE id = ?").bind(caller).first();
    if (row) {
      patientName = (JSON.parse((row as any).fields || "{}").patient_name as string) ?? null;
      sessionLang = (row as any).language || undefined;
    }
  }
  const wsUrl = `wss://${host}/relay?caller=${encodeURIComponent(caller)}`;
  const langs = Object.values(LANG_TAGS)
    .map((code) => `<Language code="${code}" ttsProvider="ElevenLabs" voice="${ELEVENLABS_VOICE}"/>`)
    .join("");
  const transcription = initialTranscription(sessionLang);
  return twimlRaw(
    `<Response><Connect><ConversationRelay url="${escapeXml(wsUrl)}" welcomeGreeting="${escapeXml(greetingText(env, patientName, sessionLang))}" ttsProvider="ElevenLabs" voice="${ELEVENLABS_VOICE}" transcriptionProvider="Deepgram" speechModel="nova-3-general" transcriptionLanguage="${transcription}" interruptible="any" reportInputDuringAgentSpeech="none">${langs}</ConversationRelay></Connect></Response>`
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
  let currentTranscription = "multi"; // set from session at setup
  let docPollTimer: ReturnType<typeof setInterval> | null = null;
  let processing = false;
  let pendingPrompt: string | null = null;

  const speak = (text: string, langCode?: string) => {
    const lang = langCode && Object.values(LANG_TAGS).includes(langCode) ? langCode : currentLang;
    server.send(JSON.stringify({ type: "text", token: text, last: true, lang }));
  };

  // Keep Deepgram's STT aligned with the caller's language. The 10 `multi`
  // languages auto-detect and code-switch on their own; Chinese (and any other
  // non-multi language) needs an explicit switch so the STT can hear it — and a
  // switch back to `multi` the moment the caller returns to a multi language.
  const syncTranscription = (isoLang: string) => {
    const target = LANG_TAGS[isoLang] && !MULTI_LANGS.has(isoLang) ? isoLang : "multi";
    if (target === currentTranscription) return;
    currentTranscription = target;
    server.send(
      JSON.stringify({
        type: "language",
        ttsLanguage: LANG_TAGS[isoLang] ?? currentLang,
        transcriptionLanguage: target,
      })
    );
  };

  const runTurn = async (input: string, keepLang = false) => {
    server.send(JSON.stringify({ type: "play", source: typingSound, loop: 1, preemptible: true, interruptible: true }));
    const session = await getOrCreateSession(env, callerPhone, "voice");
    const result = await handleTurn(env, session, input, "voice", "call");
    // language follows the CALLER's speech, never document contents;
    // system-note turns (keepLang) always stay in the call's current language
    if (!keepLang && result.decision.language) {
      currentLang = LANG_TAGS[result.decision.language] ?? currentLang;
      syncTranscription(result.decision.language);
    }
    speak(result.reply, currentLang);
    if (result.decision.send_text_request) {
      await textCallerForDoc(env, callerPhone, result.decision.send_text_request);
    }
    if (result.bookedNow && result.appointment) {
      // written confirmation to WhatsApp: sent live once Twilio KYC clears;
      // until then queued as an outbox message delivered on their next WhatsApp contact
      const a = result.appointment;
      const confirmation =
        `📅 ${result.rescheduledNow ? "Rescheduled" : "Confirmed"}: ${a.label} with ${a.clinician} ` +
        `(${a.kind === "soc_visit" ? "nurse home visit" : "clinic visit"}, ${a.location}). ` +
        `Reference ${result.refId ?? ""}. It's on the clinic calendar — a Cal.com invite follows if you shared an email. ` +
        `Please have the insurance card and a medication list ready. Reply here anytime to reschedule.`;
      const delivered = await sendMessage(env, `whatsapp:${callerPhone}`, env.TWILIO_WHATSAPP_FROM, confirmation).catch(() => false);
      if (!delivered) {
        await env.DB.prepare("INSERT INTO events (session_id, kind, detail) VALUES (?, 'outbox', ?)")
          .bind(callerPhone, confirmation).run();
      }
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
        // align the call's language with what we already know about this caller
        currentTranscription = initialTranscription(session.language);
        if (session.language && LANG_TAGS[session.language]) currentLang = LANG_TAGS[session.language];
        // record the spoken greeting so the agent never re-introduces itself
        await addMessage(env, callerPhone, "agent", "voice", "text", greetingText(env, session.fields.patient_name, session.language));
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
              "SELECT id, detail FROM events WHERE session_id = ? AND kind = 'media' AND id > ? AND detail LIKE 'Received%' ORDER BY id DESC LIMIT 1"
            ).bind(callerPhone, lastEventId).first();
            if (row2) {
              lastEventId = Number((row2 as any).id);
              const docDetail = String((row2 as any).detail ?? "a document");
              processing = true;
              try {
                await runTurn(
                  `[system note: the caller's document just arrived on WhatsApp and its fields are merged into the record. It was: "${docDetail}". Acknowledge it specifically ("I see you've shared the insurance card…"), name one captured detail and confirm it belongs to the patient ("…for Maria Lopez, Aetna — is that your mom's?"), then ask the next missing item — or move to scheduling if nothing is missing. Reply in the SAME language the caller has been speaking on this call, regardless of the document's language.]`,
                  true
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
        if (processing) {
          // caller kept talking while we were thinking — queue it, never drop it
          pendingPrompt = pendingPrompt ? `${pendingPrompt} ${msg.voicePrompt}` : msg.voicePrompt;
          return;
        }
        processing = true;
        try {
          await runTurn(msg.voicePrompt);
          while (pendingPrompt) {
            const next = pendingPrompt;
            pendingPrompt = null;
            await runTurn(next);
          }
        } catch (e) {
          console.error("relay turn error:", e);
          speak("Sorry, go ahead — I'm listening.");
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
