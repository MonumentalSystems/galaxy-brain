import "server-only"

import { createHash } from "node:crypto"
import type { NextRequest } from "next/server"
import { verifyEvent, type Event as NostrEvent } from "nostr-tools"

import { getAuthOrigin } from "@/lib/auth-config"
import { isNostrTimestampFresh } from "@/lib/auth-security"

const NOSTR_HTTP_KIND = 27235
const MAX_AUTHORIZATION_LENGTH = 16_384

function exactTag(event: NostrEvent, name: string) {
  const matches = event.tags.filter((tag) => tag[0] === name)
  if (matches.length !== 1 || matches[0].length !== 2) return null
  return matches[0][1]
}

function decodeEvent(authorization: string): NostrEvent | null {
  if (!authorization.startsWith("Nostr ")) return null
  const encoded = authorization.slice(6).trim()
  if (
    !encoded ||
    encoded.length > MAX_AUTHORIZATION_LENGTH ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) return null

  try {
    const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Partial<NostrEvent>
    if (
      !value ||
      typeof value.id !== "string" ||
      typeof value.pubkey !== "string" ||
      typeof value.sig !== "string" ||
      typeof value.kind !== "number" ||
      typeof value.created_at !== "number" ||
      typeof value.content !== "string" ||
      !Array.isArray(value.tags) ||
      !value.tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === "string"))
    ) return null
    return value as NostrEvent
  } catch {
    return null
  }
}

export async function verifyNostrHttpAuth(
  request: NextRequest,
  nowSeconds = Math.floor(Date.now() / 1_000),
  boundedBody?: Uint8Array,
): Promise<NostrEvent | null> {
  const event = decodeEvent(request.headers.get("Authorization") || "")
  if (!event) return null

  const expectedUrl = new URL(request.nextUrl.pathname + request.nextUrl.search, getAuthOrigin()).toString()
  const body = boundedBody === undefined
    ? Buffer.from(await request.clone().arrayBuffer())
    : Buffer.from(boundedBody)
  const expectedPayload = createHash("sha256").update(body).digest("hex")
  const payloadTags = event.tags.filter((tag) => tag[0] === "payload")
  const payloadTag = payloadTags.length === 0
    ? null
    : payloadTags.length === 1 && payloadTags[0].length === 2
      ? payloadTags[0][1]
      : undefined
  const validPayload = payloadTag !== undefined && (
    body.length > 0 ? payloadTag === expectedPayload : payloadTag === null || payloadTag === expectedPayload
  )

  const validShape =
    event.kind === NOSTR_HTTP_KIND &&
    event.content === "" &&
    /^[0-9a-f]{64}$/.test(event.id) &&
    /^[0-9a-f]{64}$/.test(event.pubkey) &&
    /^[0-9a-f]{128}$/.test(event.sig) &&
    isNostrTimestampFresh(event.created_at, nowSeconds) &&
    exactTag(event, "u") === expectedUrl &&
    exactTag(event, "method") === request.method.toUpperCase() &&
    validPayload

  if (!validShape) return null
  try {
    return verifyEvent(event) ? event : null
  } catch {
    return null
  }
}
