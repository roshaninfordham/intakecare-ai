export interface Env {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  // vars
  TWILIO_WHATSAPP_FROM: string;
  AGENT_NAME: string;
  ORG_NAME: string;
  TWILIO_VOICE_FROM?: string; // set after number purchase
  PUBLIC_URL?: string; // e.g. https://careline-ai.<subdomain>.workers.dev
  // secrets
  TWILIO_ACCOUNT_SID: string;
  TWILIO_API_KEY_SID: string;
  TWILIO_API_KEY_SECRET: string;
  GROQ_API_KEY: string;
  OPENROUTER_API_KEY: string;
  ELEVENLABS_API_KEY?: string;
  ADMIN_KEY: string;
}

export type Channel = "whatsapp" | "sms" | "voice";

export type SessionStatus =
  | "greeting"
  | "collecting"
  | "confirming"
  | "complete"
  | "handoff";

export interface IntakeFields {
  patient_name?: string;
  date_of_birth?: string;
  callback_phone?: string;
  address?: string;
  primary_diagnosis?: string;
  insurance_payer?: string;
  insurance_member_id?: string;
  referral_source?: string;
  // optional
  urgency?: string;
  physician_name?: string;
  preferred_language?: string;
  notes?: string;
  [key: string]: string | undefined;
}

export const REQUIRED_FIELDS: (keyof IntakeFields)[] = [
  "patient_name",
  "date_of_birth",
  "callback_phone",
  "address",
  "primary_diagnosis",
  "insurance_payer",
  "insurance_member_id",
  "referral_source",
];

export const FIELD_LABELS: Record<string, string> = {
  patient_name: "Patient name",
  date_of_birth: "Date of birth",
  callback_phone: "Callback phone",
  address: "Home address",
  primary_diagnosis: "Primary diagnosis / reason for care",
  insurance_payer: "Insurance payer",
  insurance_member_id: "Insurance member ID",
  referral_source: "Referral source (hospital / physician / self)",
  urgency: "Urgency",
  physician_name: "Physician",
  preferred_language: "Preferred language",
  notes: "Notes",
};

export interface Session {
  id: string;
  status: SessionStatus;
  fields: IntakeFields;
  packet: Record<string, unknown> | null;
  language: string;
  last_channel: Channel;
  awaiting_doc: number;
  created_at: string;
  updated_at: string;
}

export interface AgentDecision {
  reply: string;
  field_updates: Partial<IntakeFields>;
  user_confirmed: boolean;
  handoff: boolean;
  handoff_reason: string | null;
  guardrail: string | null;
  language: string;
  send_text_request: string | null; // voice: content to text the caller (doc request)
}
