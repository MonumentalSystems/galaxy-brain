import crypto from "node:crypto"
import process from "node:process"
import pg from "pg"

const email = process.argv[2]?.trim().toLowerCase()
const authOrigin = process.env.AUTH_ORIGIN?.trim().replace(/\/$/, "")
const databaseUrl = process.env.DATABASE_URL?.trim()

if (!email || !authOrigin || !databaseUrl) {
  console.error("Usage: AUTH_ORIGIN=https://workspace.example pnpm auth:issue-reset owner@example.com")
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: databaseUrl })
try {
  const userResult = await pool.query("SELECT id FROM app_users WHERE email = $1 LIMIT 1", [email])
  const user = userResult.rows[0]
  if (!user) {
    console.error("No workspace owner was found for that email.")
    process.exitCode = 1
  } else {
    const token = crypto.randomBytes(32).toString("base64url")
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex")
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [user.id])
      await client.query("DELETE FROM app_password_reset_tokens WHERE user_id = $1", [user.id])
      await client.query(
        `INSERT INTO app_password_reset_tokens (token_hash, user_id, expires_at)
         VALUES ($1, $2, now() + interval '30 minutes')`,
        [tokenHash, user.id],
      )
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    const url = new URL("/reset-password", authOrigin)
    url.searchParams.set("token", token)
    console.log(url.toString())
  }
} finally {
  await pool.end()
}
