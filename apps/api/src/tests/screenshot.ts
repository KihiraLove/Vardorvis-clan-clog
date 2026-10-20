/** In-memory PNG input and multipart requests shared by intake tests only. */
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { decodeScreenshot } from '../proof-storage.js';
import type { IconRecord } from '../icon-storage.js';
export const png = await sharp({
  create: { width: 36, height: 32, channels: 4, background: '#22334480' },
})
  .png()
  .toBuffer();
const decoded = await decodeScreenshot(png, 'image/png');
export function screenshotRecord(): IconRecord {
  return {
    id: randomUUID(),
    sha256: createHash('sha256').update(decoded.bytes).digest('hex'),
    byteSize: decoded.bytes.length,
    width: decoded.width,
    height: decoded.height,
  };
}
export function memoryProofFiles() {
  return {
    async save(bytes: Buffer, mime: string) {
      const value = await decodeScreenshot(bytes, mime);
      return {
        ...screenshotRecord(),
        sha256: createHash('sha256').update(value.bytes).digest('hex'),
        byteSize: value.bytes.length,
        width: value.width,
        height: value.height,
      };
    },
    async read() {
      return decoded.bytes;
    },
    async remove() {},
  };
}
export async function botRequest(
  input: unknown,
  headers: Record<string, string> = {},
  bytes: Buffer | null = png,
) {
  const form = new FormData();
  form.set('submission', JSON.stringify(input));
  if (bytes)
    form.set(
      'screenshot',
      new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
      'proof.png',
    );
  const encoded = new Request('https://api.example/api/v1/bot/submissions', {
    method: 'POST',
    body: form,
  });
  return {
    method: 'POST' as const,
    url: '/api/v1/bot/submissions',
    headers: {
      ...headers,
      'content-type': encoded.headers.get('content-type')!,
    },
    payload: Buffer.from(await encoded.arrayBuffer()),
  };
}
