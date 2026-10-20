/** Only the attachment supplied by Discord may be downloaded; never forward bot credentials. */
export const maxScreenshotBytes = 10 * 1024 * 1024;
export interface ScreenshotAttachment {
  id: string;
  name: string;
  url: string;
  size: number;
  contentType: string | null;
}
export class ScreenshotError extends Error {}
export function validateScreenshot(attachment: ScreenshotAttachment) {
  if (
    !attachment ||
    !/^\d{17,20}$/u.test(attachment.id) ||
    !/\.png$/iu.test(attachment.name) ||
    (attachment.contentType !== null &&
      attachment.contentType !== 'image/png') ||
    !Number.isSafeInteger(attachment.size) ||
    attachment.size < 1 ||
    attachment.size > maxScreenshotBytes
  )
    throw new ScreenshotError('Choose a PNG screenshot up to 10 MiB.');
  let url: URL;
  try {
    url = new URL(attachment.url);
  } catch {
    throw new ScreenshotError('The screenshot attachment is unavailable.');
  }
  const path = /^\/attachments\/(\d{17,20})\/(\d{17,20})\/[^/]+$/u.exec(
    url.pathname,
  );
  if (
    url.protocol !== 'https:' ||
    !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !path ||
    path[2] !== attachment.id
  )
    throw new ScreenshotError(
      'Use the PNG attachment supplied with this Discord command.',
    );
  return url;
}
export async function downloadScreenshot(
  attachment: ScreenshotAttachment,
  request: typeof fetch = fetch,
  timeoutMs = 10000,
): Promise<Uint8Array> {
  const url = validateScreenshot(attachment);
  try {
    const response = await request(url, {
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'image/png' },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Unavailable');
    }
    const contentType = response.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim();
    const length = response.headers.get('content-length');
    if (
      (contentType && contentType !== 'image/png') ||
      (length !== null &&
        (!/^\d+$/u.test(length) || Number(length) !== attachment.size))
    ) {
      await response.body.cancel();
      throw new Error('Invalid metadata');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > maxScreenshotBytes || size > attachment.size)
          throw new Error('Too large');
        chunks.push(chunk.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (
      size !== attachment.size ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)
    )
      throw new Error('Invalid PNG');
    // The API performs bounded full decoding and strips metadata before WebP storage.
    return bytes;
  } catch {
    throw new ScreenshotError(
      'The PNG screenshot could not be downloaded. Try attaching it again.',
    );
  }
}
