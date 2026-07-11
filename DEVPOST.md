# Devpost Submission — CareLine AI

## Project name
**CareLine AI**

## One-line description
A start-of-care intake voice agent that turns a home-health referral into a booked visit — in one 90-second conversation, any language, 24/7, with zero human data entry.

## Elevator pitch
The most expensive step in home health isn't clinical — it's getting the patient *into* the system. CareLine attacks the ~25¢ of every post-acute dollar spent on non-clinical work by collapsing intake — the slow, competitive, English-only, business-hours step between a hospital discharge and a nurse in the home — into a single conversation on the patient's own phone, and it **books the start-of-care visit on the agency's real calendar before the call ends.**

---

## The problem, in numbers

| Metric | Figure | Source |
|---|---|---|
| Non-clinical share of every post-acute dollar | **~25¢** | Post-acute care industry commentary (2025) — *directional* |
| US home healthcare market, 2024 → 2030 | **$162.3B → $284.3B** (9.8% CAGR) | Grand View Research |
| CMS spend on freestanding home health agencies, 2022 | **$132.9B** | CMS National Health Expenditure Accounts |
| US "distributed care" TAM | **~$400B**, ~**$200B** non-clinical admin payroll | Industry estimate — *directional* |
| SOC comprehensive assessment (incl. OASIS) deadline | **within 5 calendar days** of the SOC date | 42 CFR §484.55 |
| Timely Initiation of Care — patient seen after referral | **within ~48 hours** | NQF #0526 (CMS Care Compare) |
| National timely-initiation performance | **~96%** | CMS Care Compare |
| Coordinator time per referral packet | **~70 minutes** | Industry/trade estimates — *directional* |
| Agencies a case manager shops a referral to | **3–5; fastest to accept wins** | Industry/trade estimates — *directional* |

Intake is simultaneously **slow** (70 minutes of skilled human time per packet) and **competitive** (the fastest agency to accept keeps the patient). Slow intake = *referral leakage* = direct revenue loss — all while a 48-hour timely-initiation clock and a 5-day SOC-assessment clock are already running. CareLine removes the human data-entry step entirely, answers 24/7 in the patient's language, and converts a referral into a *scheduled visit* in seconds.

---

## What we built

One AI agent ("Cara"), one session keyed to the caller's phone number, every channel:

- Chat on **WhatsApp** in the patient's language (auto-detected, switches mid-conversation)
- Send a **voice note** — transcribed in any language
- Snap a **photo of an insurance card** — vision model reads payer + member ID
- Send a **discharge referral PDF** — every intake field extracted in one shot
- **Call and talk** to Cara live (Twilio ConversationRelay: ~1s round trips, natural American-English ElevenLabs voice, barge-in interruption)
- **Cross-channel continuity** — mid-call, send the card on WhatsApp; it lands in the *same* session and she confirms it *on the call*

Every turn is grounded in the agency's policy corpus via RAG (no invented policy), every extraction lands in a **typed JSON schema** (no hallucinated fields), and completion requires a **read-back confirmation**.

**The loop closes.** Where today's intake ends with "someone will call you in 24–48 hours," Cara verifies insurance in ~0.2s, generates a **deterministic** start-of-care packet (built from typed fields, never an LLM — zero hallucination), pulls live availability from the agency's **real Cal.com calendar**, and **books the visit in the same conversation** — urgent discharges get the earliest slot. The booking lands on the clinic's real calendar with an email invite; a written confirmation goes to the patient's WhatsApp. Reschedule the same way you booked — by chat or voice — and Cara moves the real booking. Returning callers are recognized by number, greeted by name with their history, never re-asked known info, and routed to the right specialist for their new symptoms.

**Guardrails are first-class**: hard-refuses clinical/medication questions (visible 🛡️ events on the live dashboard), routes emergencies to 911 with human handoff, runs on 100% synthetic data.

---

## Impact, measured

| | Today (manual) | With CareLine |
|---|---|---|
| Referral → **booked** visit | 3–7 days | **~90 seconds** |
| Human minutes of data entry | ~70 | **0** |
| Eligibility check | ~1 business day | **~0.2 s** |
| Availability / languages | 9-to-5, English | **24/7**, native voice EN/ES/HI/FR/PT + more |
| Infra cost | staffed call center | **$0** |

---

## Tools and technologies

| Layer | Technology | How we used it |
|---|---|---|
| **Telephony (required)** | **Twilio** | WhatsApp for inbound multimodal chat (TwiML replies); **ConversationRelay** for the real-time voice agent (Deepgram STT + ElevenLabs TTS + barge-in) over a WebSocket to our Worker; **Voice JS SDK + TwiML App** for browser & tap-to-answer calls; REST for cross-channel messages |
| Compute | **Cloudflare Workers** (Hono/TypeScript) | Orchestrator, intake state machine, WebSocket voice handler, dashboard — one edge Worker |
| Conversation brain | **Groq llama-3.3-70b** in a **6-model resilience chain** | ~300ms grounded JSON turns; fails over across Groq GPT-OSS-120B, Scout, Workers AI 70B, and two OpenRouter free models, each with independent quotas and validated JSON |
| Voice notes | **Groq whisper-large-v3-turbo** + **Deepgram nova-3** fallback | Any-language transcription with redundancy |
| Live-call STT | **Deepgram nova-3 multilingual** | Real-time recognition inside ConversationRelay (`multi` auto-detect) |
| Live-call TTS | **ElevenLabs** (Jessica) | Natural American-English voice, per-language tagging |
| Image understanding | **Groq llama-4-scout** vision | Insurance cards, referral photos |
| PDF understanding | **Cloudflare Workers AI** toMarkdown | Referral/discharge PDFs → text → structured extraction |
| RAG | **Workers AI bge-base-en-v1.5** embeddings | Policy corpus in D1, cosine retrieval in-Worker |
| Scheduling | **Cal.com API v2** | Live slots, real bookings + reschedules from chat and voice; D1 local-calendar fallback |
| State | **Cloudflare D1** | Phone-keyed sessions, transcripts, guardrail events, appointments |

**Total infrastructure cost: $0** (every service on free tier; Twilio on hackathon credit).

## Challenges we ran into
- **Free-tier quota exhaustion** (Groq's daily token cap ran dry mid-testing) → built a 6-model, 3-provider fallback chain with independent quotas so no single outage breaks a conversation.
- **Twilio KYC gating outbound sends and numbers** → synchronous TwiML webhook replies (works pre-approval) + a **tap-to-answer WebRTC call page** so Cara can "call" a patient without owning a phone number yet; a written booking confirmation is queued and delivered on the patient's next WhatsApp contact until KYC clears.
- **Booking correctness** — timezone-safe, time-derived slot IDs so the agent can never book a different time than it spoke; explicit-consent guard so "book ASAP" doesn't auto-book; reschedules persist Cal.com's new booking UID.
- **Natural, correct voice** — American-English voice, feminine grammar in gendered languages, queued (never dropped) speech when the caller talks over the agent, and language pinned to the caller's speech (never flipped by a document's language).

## What's next
- Complete Twilio Trust Hub / KYC → owned number → Cara *places* outbound scheduling calls and inbound PSTN goes live (code already wired).
- Swap synthetic eligibility rules for a real payer EDI 270/271 call.
- Coordinator-side dashboard actions (message, reschedule, mark visit complete) and multi-tenant deployment for multiple agencies.

## Live demo
- Dashboard + browser voice call: https://careline-ai.rsusny.workers.dev
- WhatsApp: join the Twilio sandbox, then message like a patient — text, voice note, card photo, referral PDF
- Repo: https://github.com/roshaninfordham/intakecare-ai

*All demo data is synthetic. No real PHI.*
