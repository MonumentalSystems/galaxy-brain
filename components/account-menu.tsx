import Link from "next/link"
import { ChevronDown, KeyRound, LogOut, ShieldCheck, UserRound, Webhook } from "lucide-react"

import { logoutAction } from "@/app/auth/actions"
import type { CurrentUser } from "@/lib/auth"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

type AccountMenuProps = {
  user: CurrentUser
  className?: string
}

/*
  The account control is its own component so a page with a top rail can seat
  it inside that rail as an ordinary item, while pages without one still get it
  pinned by AuthShell. The alternative — a fixed chip every rail has to reserve
  space around — put a floating element and a laid-out one in the same band and
  left the gap between them to guesswork.
*/
export function AccountMenu({ user, className = "" }: AccountMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={`auth-account-menu flex min-h-11 max-w-[11rem] items-center gap-2 rounded-xl border border-[var(--research-line)] bg-[hsl(var(--research-panel)/0.95)] px-3 py-2 text-sm text-foreground shadow-[0_14px_40px_-24px_hsl(var(--research-ink)/0.5)] backdrop-blur-xl transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${className}`}
        aria-label="Account and keys"
      >
        <UserRound className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">{user.name || user.email}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
          {user.email}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs uppercase tracking-wider text-muted-foreground">
          Keys
        </DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <Link href="/settings/security">
            <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" />
            Sign-in security
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings/ham">
            <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
            HAM access
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings/api-keys">
            <Webhook className="mr-2 h-4 w-4" aria-hidden="true" />
            API keys
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/*
          The form stays outside the item so Radix keeps a single focusable
          child to manage, and the item submits it rather than wrapping it.
        */}
        <form action={logoutAction}>
          <DropdownMenuItem asChild>
            <button className="w-full" type="submit">
              <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
              Sign out
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
