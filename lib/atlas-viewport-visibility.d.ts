export function observeAtlasViewportVisibility(
  element: Element,
  onChange: (visible: boolean) => void,
  Observer?: typeof IntersectionObserver,
): () => void
