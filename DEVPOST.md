# Devpost Submission — CareLine AI

## Project name
**CareLine AI**

## One-line description
A multimodal AI intake coordinator that turns healthcare's slowest step — patient intake — into a 90-second WhatsApp or voice conversation, in any language, 24/7, with zero human data entry.

## What we built and why

**The problem.** Getting a patient *into* the system is one of the most expensive, error-prone steps in healthcare: an intake coordinator spends ~70 minutes per referral packet; the process runs on phone tag, fax, English, and business hours. ~25.7M US residents have limited English proficiency, and the world is short ~11M health workers. Every hour of intake delay is a lost referral and a patient waiting for care.

**The solution.** One AI agent ("Cara"), one session keyed to the caller's phone number, every channel:

- Chat on **WhatsApp** in 30+ languages (auto-detected, mid-conversation switching)
- Send a **voice note** — Whisper transcribes it
- Snap a **photo of an insurance card** — a vision model reads the payer and member ID
- Send a **discharge referral PDF** — every intake field extracted in one shot
- **Call and talk** to Cara live (Twilio ConversationRelay: ~1s round trips, natural ElevenLabs voice, barge-in interruption)
- **Cross-channel continuity**: mid-call, Cara asks for the insurance card over WhatsApp; the photo lands in the *same* session and she confirms it *on the call*

Every conversation is grounded in the agency's policy corpus via RAG (no invented policy), every extraction lands in a **typed JSON schema** (no hallucinated fields), and completion requires a **read-back confirmation**.

**And the loop actually closes.** Where today's intake ends with "someone will call you within 24–48 hours," Cara pulls live availability from the agency's **real Cal.com calendar** and **books the start-of-care visit in the same conversation** — urgent discharges get the earliest slot, and the booking lands on the clinic's actual calendar (with invites/sync). Patients reschedule the same way they booked: by chat or by voice. If Cal.com is ever unreachable, the agent degrades gracefully to a local D1 calendar — the conversation never breaks. Output: booked appointment + start-of-care packet + live ops dashboard + confirmation message. Referral-to-scheduled-visit, which takes 3–7 days of phone tag today, happens in one conversation. An outbound-call endpoint is wired so Cara can also *place* the scheduling call herself (pending Twilio number provisioning).

**Guardrails are first-class**: the agent hard-refuses clinical/medication questions (visible 🛡️ events on the dashboard), directs emergencies to 911 with human handoff, and runs on 100% synthetic data.

## Tools and technologies

| Layer | Technology | How we used it |
|---|---|---|
| **Telephony (required)** | **Twilio** | WhatsApp Sandbox for inbound multimodal chat (TwiML replies); **ConversationRelay** for the real-time voice agent (Deepgram STT + ElevenLabs TTS + interruption handling) over a WebSocket to our Worker; **Voice JS SDK + TwiML App** for in-browser calls from the dashboard; REST API for cross-channel messages |
| Compute | **Cloudflare Workers** (Hono/TypeScript) | Orchestrator, intake state machine, WebSocket voice handler, dashboard hosting — all on one edge Worker |
| Conversation brain | **Groq llama-3.3-70b** | ~300ms grounded JSON-mode turns; OpenRouter free tier as automatic fallback |
| Voice notes | **Groq whisper-large-v3-turbo** + **Deepgram nova-3** fallback | Any-language transcription with automatic redundancy |
| Live-call STT | **Deepgram nova-3 multilingual** | Real-time speech recognition inside ConversationRelay (`multi` auto-detection) |
| Image understanding | **Groq llama-4-scout** vision | Insurance cards, referral photos |
| PDF understanding | **Cloudflare Workers AI** toMarkdown | Referral/discharge PDFs → text → structured extraction |
| RAG | **Workers AI bge-base-en-v1.5** embeddings | Policy corpus in D1, cosine retrieval in-Worker |
| Scheduling | **Cal.com API v2** | Live slots, real bookings + reschedules from chat and voice; local D1 calendar fallback |
| State | **Cloudflare D1** | Phone-number-keyed sessions, transcripts, guardrail event log |

Total infrastructure cost: **$0** (every service on free tier; Twilio on hackathon promo credit).

## Live demo
- Dashboard + browser voice call: https://careline-ai.rsusny.workers.dev
- WhatsApp: join the Twilio sandbox, then message like a patient — text, voice note, card photo, referral PDF
- Repo: https://github.com/roshaninfordham/intakecare-ai
