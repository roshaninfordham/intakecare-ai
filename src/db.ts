import { Channel, Env, IntakeFields, Session, SessionStatus } from "./types";

export async function getOrCreateSession(env: Env, phone: string, channel: Channel): Promise<Session> {
  const row = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(phone).first();
  if (row) return rowToSession(row);
  await env.DB.prepare(
    "INSERT INTO sessions (id, status, fields, last_channel) VALUES (?, 'greeting', '{}', ?)"
  )
    .bind(phone, channel)
    .run();
  const fresh = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(phone).first();
  return rowToSession(fresh!);
}

export function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    status: row.status as SessionStatus,
    fields: JSON.parse((row.fields as string) || "{}") as IntakeFields,
    packet: row.packet ? JSON.parse(row.packet as string) : null,
    language: (row.language as string) ?? "en",
    last_channel: (row.last_channel as Channel) ?? "whatsapp",
    awaiting_doc: (row.awaiting_doc as number) ?? 0,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export async function saveSession(env: Env, s: Session): Promise<void> {
  await env.DB.prepare(
    `UPDATE sessions SET status=?, fields=?, packet=?, language=?, last_channel=?, awaiting_doc=?, updated_at=datetime('now') WHERE id=?`
  )
    .bind(
      s.status,
      JSON.stringify(s.fields),
      s.packet ? JSON.stringify(s.packet) : null,
      s.language,
      s.last_channel,
      s.awaiting_doc,
      s.id
    )
    .run();
}

export async function addMessage(
  env: Env,
  sessionId: string,
  role: "user" | "agent",
  channel: Channel,
  kind: string,
  content: string,
  mediaUrl?: string | null,
  mediaType?: string | null
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO messages (session_id, role, channel, kind, content, media_url, media_type) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(sessionId, role, channel, kind, content, mediaUrl ?? null, mediaType ?? null)
    .run();
}

export async function recentMessages(
  env: Env,
  sessionId: string,
  limit = 12
): Promise<{ role: string; content: string; kind: string; channel: string }[]> {
  const { results } = await env.DB.prepare(
    "SELECT role, content, kind, channel FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?"
  )
    .bind(sessionId, limit)
    .all();
  return (results as any[]).reverse();
}

export async function logEvent(env: Env, sessionId: string | null, kind: string, detail: string): Promise<void> {
  await env.DB.prepare("INSERT INTO events (session_id, kind, detail) VALUES (?, ?, ?)")
    .bind(sessionId, kind, detail)
    .run();
}
