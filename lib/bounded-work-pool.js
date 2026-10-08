/** Run an ordered map with a fixed worker count and abort remaining work after the first failure. */
export async function mapWithBoundedConcurrency(values, concurrency, worker) {
  if (!Array.isArray(values) || !Number.isSafeInteger(concurrency) || concurrency < 1
    || typeof worker !== "function") {
    throw new TypeError("Invalid bounded work pool input")
  }
  if (values.length === 0) return []

  const results = new Array(values.length)
  const controller = new AbortController()
  let nextIndex = 0
  let failed = false
  let firstError

  async function runWorker() {
    while (!controller.signal.aborted) {
      const index = nextIndex
      nextIndex += 1
      if (index >= values.length) return
      try {
        results[index] = await worker(values[index], index, controller.signal)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
          controller.abort(error)
        }
        return
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => runWorker(),
  ))
  if (failed) throw firstError
  return results
}
