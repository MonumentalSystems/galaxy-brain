import "server-only"

import nodemailer from "nodemailer"

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null

function getTransporter() {
  const url = process.env.SMTP_URL?.trim()
  if (!url) return null
  transporter ||= nodemailer.createTransport(url)
  return transporter
}

export function isPasswordResetEmailConfigured() {
  return Boolean(process.env.SMTP_URL?.trim() && process.env.AUTH_EMAIL_FROM?.trim())
}

export async function sendPasswordResetEmail(email: string, resetUrl: string) {
  const mailer = getTransporter()
  const from = process.env.AUTH_EMAIL_FROM?.trim()
  if (!mailer || !from) return false

  await mailer.sendMail({
    from,
    to: email,
    subject: "Reset your Galaxy Brain password",
    text: [
      "A password reset was requested for your Galaxy Brain workspace.",
      "",
      `Reset your password: ${resetUrl}`,
      "",
      "This link expires in 30 minutes and can be used once. If you did not request it, ignore this message.",
    ].join("\n"),
  })
  return true
}
