/** Bound aggregate readiness even when a dependency never settles. */
export async function checkReadiness(
  database: () => Promise<void>,
  bot?: () => Promise<void>,
  timeoutMs = 3500,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([database(), bot?.()]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Readiness timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function checkBotReadiness(): Promise<void> {
  const response = await fetch('http://127.0.0.1:3001/readyz', {
    signal: AbortSignal.timeout(2500),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error('Discord intake is not ready');
}
