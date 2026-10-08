/** Durable generated filenames; decode/re-encode uploads before they can become public. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import sharp from 'sharp';
import { ApiError } from './types.js';
export const MAX_ICON_BYTES = 2 * 1024 * 1024;
export const assetIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export interface IconRecord {
  id: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
}
export const iconPath = (id: string) => `/api/v1/catalog/icons/${id}.png`;
export async function decodeIcon(input: Buffer, mime: string) {
  if (!input.length || input.length > MAX_ICON_BYTES)
    throw new ApiError(413, 'Choose an icon up to 2 MiB.');
  if (!['image/png', 'image/webp'].includes(mime))
    throw new ApiError(400, 'Choose a PNG or WebP icon.');
  try {
    const decoder = sharp(input, {
      limitInputPixels: 512 * 512,
      failOn: 'warning',
      animated: true,
    });
    const metadata = await decoder.metadata();
    if (
      'image/' + metadata.format !== mime ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 512 ||
      metadata.height > 512 ||
      (metadata.pages ?? 1) !== 1
    )
      throw new Error('Unsupported dimensions or animation');
    // Native pixels and alpha are retained; scripts, metadata and trailing input are discarded.
    const { data, info } = await decoder
      .png()
      .toBuffer({ resolveWithObject: true });
    if (data.length > MAX_ICON_BYTES) throw new Error('Decoded icon too large');
    return { bytes: data, width: info.width, height: info.height };
  } catch {
    throw new ApiError(
      400,
      'The icon must decode as a still PNG or WebP between 1 and 512 pixels.',
    );
  }
}
export class IconStorage {
  constructor(readonly directory: string) {
    if (!isAbsolute(directory))
      throw new Error('ICON_STORAGE_PATH must be an absolute path');
  }
  private path(id: string) {
    if (!assetIdPattern.test(id)) throw new ApiError(404, 'Icon not found.');
    return join(this.directory, id + '.png');
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    const probe = await this.save(
      await sharp({
        create: { width: 1, height: 1, channels: 4, background: '#00000000' },
      })
        .png()
        .toBuffer(),
      'image/png',
    );
    await this.remove(probe.id);
  }
  async save(input: Buffer, mime: string): Promise<IconRecord> {
    const decoded = await decodeIcon(input, mime);
    const id = randomUUID(),
      destination = this.path(id),
      temporary = destination + '.tmp';
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(decoded.bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
      // Persist directory entries before committing any database reference (Linux containers).
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch {
      await unlink(temporary).catch(() => {});
      await unlink(destination).catch(() => {});
      throw new ApiError(503, 'Icon storage is unavailable. Try again later.');
    }
    return {
      id,
      width: decoded.width,
      height: decoded.height,
      byteSize: decoded.bytes.length,
      sha256: createHash('sha256').update(decoded.bytes).digest('hex'),
    };
  }
  async read(record: IconRecord) {
    try {
      const bytes = await readFile(this.path(record.id));
      if (
        bytes.length !== record.byteSize ||
        createHash('sha256').update(bytes).digest('hex') !== record.sha256
      )
        throw new Error('Icon checksum mismatch');
      return bytes;
    } catch {
      throw new ApiError(503, 'Icon storage is unavailable.');
    }
  }
  async remove(id: string) {
    await unlink(this.path(id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
