import { getCurrentUser } from "@/lib/auth"
import { ensureAppSchema, getPool } from "@/lib/db"

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return Response.json({ error: "Sign in to view security settings." }, { status: 401 })
  await ensureAppSchema()
  const [passkeys, nostrKeys] = await Promise.all([
    getPool().query(
      `SELECT id, COALESCE(label, 'Passkey') AS label, created_at, last_used_at, backed_up
         FROM app_passkeys WHERE user_id = $1 ORDER BY created_at`,
      [user.id],
    ),
    getPool().query(
      `SELECT id, COALESCE(label, 'Nostr key') AS label, pubkey, created_at, last_used_at
         FROM app_nostr_keys WHERE user_id = $1 ORDER BY created_at`,
      [user.id],
    ),
  ])
  return Response.json({ passkeys: passkeys.rows, nostrKeys: nostrKeys.rows })
}

export async function DELETE(request: Request) {
  const user = await getCurrentUser()
  if (!user) return Response.json({ error: "Sign in to change security settings." }, { status: 401 })
  const body = (await request.json().catch(() => ({}))) as { kind?: "passkey" | "nostr"; id?: string }
  if (!body.id || !["passkey", "nostr"].includes(body.kind || "")) {
    return Response.json({ error: "Credential selection is invalid." }, { status: 400 })
  }
  await ensureAppSchema()
  const table = body.kind === "passkey" ? "app_passkeys" : "app_nostr_keys"
  const result = await getPool().query(`DELETE FROM ${table} WHERE id = $1 AND user_id = $2`, [body.id, user.id])
  if (!result.rowCount) return Response.json({ error: "Credential not found." }, { status: 404 })
  return Response.json({ ok: true })
}
