export function resolveWorkspaceView<T extends string>(options: {
  requestedView?: string | null
  preferredView?: string | null
  allowedViewModes: readonly T[]
  fallbackView: T
}): T
