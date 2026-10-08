export function focusFirstConnected(
  candidates: Array<HTMLElement | null | undefined>,
  excludedRoot?: HTMLElement | null,
) {
  for (const candidate of candidates) {
    if (
      !candidate?.isConnected
      || excludedRoot?.contains(candidate)
      || candidate.matches(":disabled, [aria-disabled='true'], [inert], [inert] *")
    ) continue
    candidate.focus({ preventScroll: true })
    if (document.activeElement === candidate) return true
  }
  return false
}
