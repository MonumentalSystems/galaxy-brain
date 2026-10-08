/**
 * Observe the real browser viewport with no root margin. canvas-harness keeps
 * React overlays mounted inside an inflated cache viewport, so mount state is
 * not sufficient authorization to start exact-body network work.
 */
export function observeAtlasViewportVisibility(element, onChange, Observer = globalThis.IntersectionObserver) {
  if (!element || typeof onChange !== "function") throw new TypeError("Atlas visibility target is invalid")
  onChange(false)
  if (typeof Observer !== "function") return () => undefined
  const observer = new Observer((entries) => {
    const entry = entries.find((candidate) => candidate.target === element)
    onChange(Boolean(entry?.isIntersecting && entry.intersectionRatio > 0))
  }, { root: null, rootMargin: "0px", threshold: 0 })
  observer.observe(element)
  return () => {
    observer.unobserve(element)
    observer.disconnect()
    onChange(false)
  }
}
