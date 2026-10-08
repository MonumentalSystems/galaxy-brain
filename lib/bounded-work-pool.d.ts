export function mapWithBoundedConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number, signal: AbortSignal) => Promise<R>,
): Promise<R[]>
