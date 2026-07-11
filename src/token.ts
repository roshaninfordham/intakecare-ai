import { Env } from "./types";

export const TWIML_APP_SID = "AP331ab94d2d63368d3a0e9e63a8b07ace";

function b64url(data: string | ArrayBuffer): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Twilio Voice access token (JWT, HS256 with the API key secret) for browser calls. */
export async function voiceAccessToken(env: Env, identity: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" };
  const payload = {
    jti: `${env.TWILIO_API_KEY_SID}-${now}`,
    iss: env.TWILIO_API_KEY_SID,
    sub: env.TWILIO_ACCOUNT_SID,
    iat: now,
    exp: now + 3600,
    grants: {
      identity,
      voice: { outgoing: { application_sid: TWIML_APP_SID } },
    },
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.TWILIO_API_KEY_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}
