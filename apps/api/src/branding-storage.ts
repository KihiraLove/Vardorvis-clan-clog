/** Rasterise arbitrary supported images, keeping GIF/WebP timing and loop metadata. */
import sharp from 'sharp';
import { IconStorage, type IconRecord } from './icon-storage.js';
import { ApiError } from './types.js';
export const MAX_LOGO_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 64 * 1024 * 1024;
const formats = new Set(['jpeg', 'png', 'webp', 'gif', 'svg', 'heif', 'tiff']);
export interface LogoRecord {
  logo: IconRecord;
  favicon: IconRecord;
}
export async function decodeLogo(input: Buffer) {
  if (!input.length || input.length > MAX_LOGO_BYTES)
    throw new ApiError(413, 'Choose a logo up to 10 MiB.');
  try {
    const options = {
      limitInputPixels: MAX_PIXELS,
      failOn: 'warning' as const,
    };
    const metadata = await sharp(input, options).metadata();
    if (!metadata.format || !formats.has(metadata.format))
      throw new Error('Format');
    const animated = ['gif', 'webp'].includes(metadata.format);
    const frames = animated ? (metadata.pages ?? 1) : 1;
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > 8192 ||
      metadata.height > 8192 ||
      frames > 300 ||
      metadata.width * metadata.height * frames > MAX_PIXELS
    )
      throw new Error('Dimensions');
    const decoder = sharp(input, { ...options, animated });
    if (!animated) decoder.autoOrient();
    const { data, info } = await decoder
      .resize({
        width: 1024,
        height: 1024,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ lossless: true, effort: 2 })
      .timeout({ seconds: 5 })
      .toBuffer({ resolveWithObject: true });
    if (data.length > MAX_LOGO_BYTES) throw new Error('Output size');
    return {
      bytes: data,
      width: info.width,
      height: info.pageHeight ?? info.height,
    };
  } catch {
    throw new ApiError(
      400,
      'Choose a readable JPEG, PNG, GIF, WebP, SVG, AVIF or TIFF logo (up to 8192 pixels per side, 300 frames and 64 megapixels total).',
    );
  }
}
export class BrandingStorage extends IconStorage {
  protected override decode(input: Buffer) {
    return decodeLogo(input);
  }
  readonly favicons: IconStorage;
  constructor(directory: string) {
    super(directory);
    this.favicons = new IconStorage(directory);
  }
  async saveLogo(input: Buffer): Promise<LogoRecord> {
    const logo = await this.save(input, 'application/octet-stream');
    try {
      // Derive the favicon from the stored logo, so orientation, colour and frame agree.
      const firstFrame = await sharp(await this.read(logo), { pages: 1 })
        .resize(64, 64, { fit: 'contain', background: '#00000000' })
        .webp({ lossless: true, effort: 2 })
        .toBuffer();
      return {
        logo,
        favicon: await this.favicons.save(firstFrame, 'image/webp'),
      };
    } catch (error) {
      await this.remove(logo.id);
      throw error;
    }
  }
  async removeLogo(record: LogoRecord) {
    await this.remove(record.logo.id);
    await this.favicons.remove(record.favicon.id);
  }
}
