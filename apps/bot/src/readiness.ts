/** Bound readiness probes against the real authenticated internal intake API. */
export function cachedReadiness(
  probe: () => Promise<boolean>,
  ttlMs = 5000,
  now: () => number = Date.now,
): () => Promise<boolean> {
  let checkedAt: number | null = null;
  let healthy = false;
  let pending: Promise<boolean> | null = null;
  return async () => {
    const time = now();
    if (checkedAt !== null && time >= checkedAt && time - checkedAt < ttlMs)
      return healthy;
    if (!pending) {
      pending = probe()
        .then((result) => {
          healthy = result;
          return healthy;
        })
        .catch(() => {
          healthy = false;
          return false;
        })
        .finally(() => {
          checkedAt = now();
          pending = null;
        });
    }
    return pending;
  };
}
