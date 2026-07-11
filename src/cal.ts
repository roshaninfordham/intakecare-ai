import { Env, Slot } from "./types";

const CAL_BASE = "https://api.cal.com/v2";

function headers(env: Env, apiVersion: string): Record<string, string> {
  return {
    Authorization: `Bearer ${env.CAL_API_KEY}`,
    "cal-api-version": apiVersion,
    "Content-Type": "application/json",
  };
}

/** Live availability from the agency's real Cal.com calendar (next `days` days). */
export async function getCalSlots(env: Env, days = 4, limit = 6): Promise<Slot[]> {
  const start = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
  const end = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  const res = await fetch(
    `${CAL_BASE}/slots?eventTypeId=${env.CAL_EVENT_TYPE_ID}&start=${start}&end=${end}&timeZone=America/New_York`,
    { headers: headers(env, "2024-09-04") }
  );
  if (!res.ok) throw new Error(`cal slots ${res.status}: ${await res.text()}`);
  const data = ((await res.json()) as any).data as Record<string, { start: string }[]>;
  const out: Slot[] = [];
  let id = 1;
  for (const day of Object.keys(data).sort()) {
    for (const s of data[day]) {
      if (out.length >= limit) break;
      const dt = new Date(s.start);
      out.push({
        id: id++,
        start_ts: s.start,
        label: dt.toLocaleString("en-US", {
          weekday: "short", month: "short", day: "numeric",
          hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
        }),
        kind: "soc_visit",
        clinician: "CareLine RN team",
        location: "patient's home",
      });
    }
  }
  return out;
}

export interface CalBooking {
  uid: string;
  start: string;
}

/** Book a real appointment on the agency calendar. */
export async function createCalBooking(
  env: Env,
  startIso: string,
  patientName: string,
  phone: string,
  email?: string
): Promise<CalBooking> {
  const res = await fetch(`${CAL_BASE}/bookings`, {
    method: "POST",
    headers: headers(env, "2024-08-13"),
    body: JSON.stringify({
      start: new Date(startIso).toISOString(),
      eventTypeId: Number(env.CAL_EVENT_TYPE_ID),
      attendee: {
        name: patientName,
        email: email || `intake-${phone.replace(/\D/g, "")}@careline.invalid`,
        timeZone: "America/New_York",
        language: "en",
      },
      metadata: { source: "careline-ai", phone: phone.slice(0, 30) },
    }),
  });
  if (!res.ok) throw new Error(`cal booking ${res.status}: ${await res.text()}`);
  const data = ((await res.json()) as any).data;
  return { uid: data.uid, start: data.start };
}

/** Cancel a booking (used by admin/reset so demo re-runs don't leave ghost bookings). */
export async function cancelCalBooking(env: Env, uid: string): Promise<void> {
  await fetch(`${CAL_BASE}/bookings/${uid}/cancel`, {
    method: "POST",
    headers: headers(env, "2024-08-13"),
    body: JSON.stringify({ cancellationReason: "Demo session reset" }),
  });
}

/** Move an existing booking to a new time (reschedule by chat or voice). */
export async function rescheduleCalBooking(env: Env, uid: string, newStartIso: string): Promise<CalBooking> {
  const res = await fetch(`${CAL_BASE}/bookings/${uid}/reschedule`, {
    method: "POST",
    headers: headers(env, "2024-08-13"),
    body: JSON.stringify({
      start: new Date(newStartIso).toISOString(),
      reschedulingReason: "Patient requested a new time via CareLine AI",
    }),
  });
  if (!res.ok) throw new Error(`cal reschedule ${res.status}: ${await res.text()}`);
  const data = ((await res.json()) as any).data;
  return { uid: data.uid, start: data.start };
}
