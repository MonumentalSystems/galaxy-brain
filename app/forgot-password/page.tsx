import { PasswordRecoveryForm } from "@/components/password-recovery-form"
import { getRecoveryContact } from "@/lib/auth-config"

export default function ForgotPasswordPage() {
  return <PasswordRecoveryForm recoveryContact={getRecoveryContact()} />
}
