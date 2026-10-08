import type { ReactNode } from "react"

import type { CurrentUser } from "@/lib/auth"
import { AccountMenu } from "@/components/account-menu"
import { GalaxyLensNav } from "@/components/workspace/galaxy-lens-nav"

type AuthShellProps = {
  user: CurrentUser
  children: ReactNode
  /**
   * Set by a page that seats the account menu in its own top rail, so the
   * shell does not also pin a floating copy in the same corner.
   */
  ownsAccountMenu?: boolean
}

export function AuthShell({ user, children, ownsAccountMenu = false }: AuthShellProps) {
  /*
    The lens rail sits along the bottom at every width, so the page gives up no
    right-hand column to it — only the bottom clearance the small-screen layout
    always reserved.
  */
  return (
    <div className="auth-shell pb-20">
      {!ownsAccountMenu && (
        <div className="fixed right-4 top-4 z-50">
          <AccountMenu user={user} />
        </div>
      )}
      {children}
      <GalaxyLensNav />
    </div>
  )
}
