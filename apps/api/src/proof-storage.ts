/** Private screenshots: bounded PNG decoding, metadata removal and durable immutable files. */
import sharp from 'sharp';
import { IconStorage } from './icon-storage.js';
import { ApiError } from './types.js';
export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
export async function decodeScreenshot(input: Buffer, mime: string) {
  if (!input.length || input.length > MAX_SCREENSHOT_BYTES)
    throw new ApiError(413, 'Choose a PNG screenshot up to 10 MiB.');
  if (mime !== 'image/png') throw new ApiError(400, 'Choose a PNG screenshot.');
  try {
    const decoder = sharp(input, {
      limitInputPixels: 32 * 1024 * 1024,
      failOn: 'warning',
      animated: true,
    });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== 'png' ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 8192 ||
      metadata.height > 8192 ||
      (metadata.pages ?? 1) !== 1
    )
      throw new Error('Invalid screenshot');
    const { data, info } = await decoder
      .png()
      .toBuffer({ resolveWithObject: true });
    if (data.length > MAX_SCREENSHOT_BYTES)
      throw new Error('Decoded screenshot too large');
    return { bytes: data, width: info.width, height: info.height };
  } catch {
    throw new ApiError(
      400,
      'Screenshot must be a valid still PNG, at most 8192 pixels per side and 32 megapixels.',
    );
  }
}
export class ProofStorage extends IconStorage {
  protected override decode(input: Buffer, mime: string) {
    return decodeScreenshot(input, mime);
  }
}
