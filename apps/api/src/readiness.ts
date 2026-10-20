/** Bound aggregate readiness even when a dependency never settles. */
import type { DiscordConnectionState } from '@clog/domain';
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
/** Only expose an allowlisted connection state, never the bot's diagnostic payload. */
export async function readBotConnectionState(): Promise<
  Exclude<DiscordConnectionState, 'disabled'>
> {
  const response = await fetch('http://127.0.0.1:3001/readyz', {
    signal: AbortSignal.timeout(2500),
    redirect: 'error',
    cache: 'no-store',
  });
  if (response.status !== 200 && response.status !== 503)
    throw new Error('Bot status unavailable');
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid bot status');
  const body = value as Record<string, unknown>;
  if (
    response.ok &&
    body.status === 'ready' &&
    body.discordConfigured === true &&
    body.discordConnected === true &&
    body.apiConnected === true &&
    (body.connectionState === undefined || body.connectionState === 'connected')
  )
    return 'connected';
  if (
    response.status === 503 &&
    body.status === 'not-ready' &&
    body.discordConfigured === true &&
    body.discordConnected === false &&
    body.apiConnected === false &&
    (body.connectionState === 'connecting' ||
      body.connectionState === 'disconnected')
  )
    return body.connectionState;
  return 'unavailable';
}
