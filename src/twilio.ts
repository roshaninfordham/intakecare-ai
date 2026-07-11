import { Buffer } from "node:buffer";
import { Env } from "./types";

const API_BASE = "https://api.twilio.com/2010-04-01";

function authHeader(env: Env): string {
  return "Basic " + Buffer.from(`${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`).toString("base64");
}

/** Send an outbound message. `to`/`from` include channel prefix, e.g. whatsapp:+1555... */
export async function sendMessage(env: Env, to: string, from: string, body: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: authHeader(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!res.ok) console.error(`twilio send failed ${res.status}: ${await res.text()}`);
  return res.ok;
}

/**
 * Download Twilio media. Twilio returns a redirect to S3; we must NOT forward
 * the Authorization header to S3, so follow the redirect manually.
 */
export async function fetchTwilioMedia(
  env: Env,
  url: string
): Promise<{ data: ArrayBuffer; contentType: string }> {
  // self-hosted demo assets: a Worker can't fetch its own hostname, use the assets binding
  if (new URL(url).hostname.endsWith("workers.dev")) {
    const res = await env.ASSETS.fetch(url);
    if (!res.ok) throw new Error(`asset fetch ${res.status}`);
    return {
      data: await res.arrayBuffer(),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }
  let res = await fetch(url, {
    headers: { Authorization: authHeader(env) },
    redirect: "manual",
  });
  let hops = 0;
  while (res.status >= 300 && res.status < 400 && hops < 5) {
    const loc = res.headers.get("location");
    if (!loc) break;
    res = await fetch(loc, { redirect: "manual" });
    hops++;
  }
  if (!res.ok) throw new Error(`media fetch ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  return { data: await res.arrayBuffer(), contentType };
}

export function twimlMessages(bodies: string[]): Response {
  const inner = bodies.map((b) => `<Message>${escapeXml(b)}</Message>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    headers: { "Content-Type": "text/xml" },
  });
}

export function twimlMessage(body?: string): Response {
  const inner = body ? `<Message>${escapeXml(body)}</Message>` : "";
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    headers: { "Content-Type": "text/xml" },
  });
}

export function twimlRaw(xml: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${xml}`, {
    headers: { "Content-Type": "text/xml" },
  });
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Strip channel prefix: "whatsapp:+1555..." -> "+1555..." */
export function normalizePhone(raw: string): { phone: string; channel: "whatsapp" | "sms" } {
  if (raw.startsWith("whatsapp:")) return { phone: raw.slice(9), channel: "whatsapp" };
  return { phone: raw, channel: "sms" };
}
