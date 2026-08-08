import type { IncomingHttpHeaders } from "node:http";

import type { ExecutionEngine } from "./execution-engine.js";

/**
 * Sticky conversation → account / SDK agent mapping.
 *
 * Conversation id resolution precedence (first wins):
 * 1. Header `X-Cursor-Conversation-Id` (recommended for clients)
 * 2. JSON body `conversation_id`
 * 3. OpenAI `user` when it looks like a durable opaque id (not an email)
 *
 * Env: none required — map is in-memory for the proxy process lifetime.
 */

export type SessionAffinity = {
  configDir: string;
  /** SDK local agent id when engine=sdk; undefined for ACP sticky pin-only. */
  agentId?: string;
  engine: ExecutionEngine;
  updatedAt: number;
};

const affinityByConversation = new Map<string, SessionAffinity>();

/** Max entries; oldest updatedAt evicted when exceeded. */
const MAX_ENTRIES = 10_000;

export function resetSessionAffinityForTests(): void {
  affinityByConversation.clear();
}

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0]?.trim() || undefined;
  if (typeof raw === "string") return raw.trim() || undefined;
  return undefined;
}

function looksLikeOpaqueId(value: string): boolean {
  if (value.length < 8 || value.length > 200) return false;
  if (value.includes("@")) return false;
  if (/\s/.test(value)) return false;
  return true;
}

export function resolveConversationId(
  headers: IncomingHttpHeaders,
  body: { conversation_id?: unknown; user?: unknown },
): string | undefined {
  const fromHeader = headerValue(headers, "x-cursor-conversation-id");
  if (fromHeader) return fromHeader;

  if (typeof body.conversation_id === "string") {
    const id = body.conversation_id.trim();
    if (id) return id;
  }

  if (typeof body.user === "string") {
    const user = body.user.trim();
    if (looksLikeOpaqueId(user)) return user;
  }

  return undefined;
}

export function getSessionAffinity(
  conversationId: string,
): SessionAffinity | undefined {
  return affinityByConversation.get(conversationId);
}

export function bindSessionAffinity(
  conversationId: string,
  binding: Omit<SessionAffinity, "updatedAt">,
): void {
  affinityByConversation.set(conversationId, {
    ...binding,
    updatedAt: Date.now(),
  });
  evictIfNeeded();
}

/** Drop SDK agent id after resume/account failure; keep account pin for retry. */
export function clearSessionAgentId(conversationId: string): void {
  const cur = affinityByConversation.get(conversationId);
  if (!cur?.agentId) return;
  affinityByConversation.set(conversationId, {
    ...cur,
    agentId: undefined,
    updatedAt: Date.now(),
  });
}

/** Forget the conversation entirely (e.g. account exhausted → new account). */
export function clearSessionAffinity(conversationId: string): void {
  affinityByConversation.delete(conversationId);
}

function evictIfNeeded(): void {
  if (affinityByConversation.size <= MAX_ENTRIES) return;
  const entries = [...affinityByConversation.entries()].sort(
    (a, b) => a[1].updatedAt - b[1].updatedAt,
  );
  const drop = affinityByConversation.size - MAX_ENTRIES;
  for (let i = 0; i < drop; i++) {
    affinityByConversation.delete(entries[i]![0]);
  }
}
