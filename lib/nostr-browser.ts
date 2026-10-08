type UnsignedNostrEvent = {
  created_at: number
  kind: number
  tags: string[][]
  content: string
}

export type SignedNostrEvent = UnsignedNostrEvent & {
  id: string
  pubkey: string
  sig: string
}

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>
      signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent>
    }
  }
}

export async function signNostrAuthEvent(options: { challenge: string; url: string }) {
  if (!window.nostr) {
    throw new Error("No NIP-07 Nostr signer was found in this browser.")
  }
  return window.nostr.signEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", options.url],
      ["method", "POST"],
      ["challenge", options.challenge],
    ],
    content: "",
  })
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function utf8Base64(value: string) {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function exactArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

/** Create a fresh payload-bound NIP-98 authorization value for one exact request. */
export async function signNostrHttpRequest(options: {
  url: string
  method: string
  body?: Uint8Array
}) {
  if (!window.nostr) {
    throw new Error("No NIP-07 Nostr signer was found in this browser.")
  }
  const body = options.body ?? new Uint8Array()
  let target: URL
  try {
    target = new URL(options.url)
  } catch {
    throw new Error("The canonical Nostr request target is invalid.")
  }
  if (!/^https?:$/u.test(target.protocol)) {
    throw new Error("The canonical Nostr request target must use HTTP or HTTPS.")
  }
  const payload = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", exactArrayBuffer(body))))
  const event = await window.nostr.signEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", target.toString()],
      ["method", options.method.toUpperCase()],
      ["payload", payload],
    ],
    content: "",
  })
  return `Nostr ${utf8Base64(JSON.stringify(event))}`
}

export async function getCanonicalNostrRequestTarget(path: string) {
  const response = await fetch(`/api/auth/nostr/request-target?${new URLSearchParams({ path })}`, {
    cache: "no-store",
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body
      ? String((body as { error?: unknown }).error || "")
      : ""
    throw new Error(error || "The canonical Nostr request target is unavailable.")
  }
  if (!body || typeof body !== "object" || (body as { schemaId?: unknown }).schemaId !== "gb.nostr-request-target.v1") {
    throw new Error("The canonical Nostr request target response is invalid.")
  }
  const url = (body as { url?: unknown }).url
  if (typeof url !== "string") throw new Error("The canonical Nostr request target response is invalid.")
  return url
}
