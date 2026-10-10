/** Settle on cancellation even if a client ignores its signal. */
export function withAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
