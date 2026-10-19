/** Shared bounded multipart parsing for PNG intake; decoding happens before storage. */
import type { FastifyRequest } from 'fastify';
import { MAX_SCREENSHOT_BYTES } from './proof-storage.js';
import { ApiError } from './types.js';
export const screenshotLimits = {
  fileSize: MAX_SCREENSHOT_BYTES,
  files: 1,
  parts: 7,
  fields: 6,
  fieldSize: 8193,
};
export async function screenshotParts(
  request: FastifyRequest,
  required: string[],
  optional: string[] = [],
  requireFile = true,
) {
  if (!request.isMultipart())
    throw new ApiError(400, 'Use multipart/form-data.');
  const fields: Record<string, string> = {};
  let file: { bytes: Buffer; mime: string } | undefined;
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (file || part.fieldname !== 'screenshot')
        throw new ApiError(400, 'Supply one screenshot file.');
      const bytes = await part.toBuffer();
      if (part.file.truncated)
        throw new ApiError(413, 'Choose a PNG screenshot up to 10 MiB.');
      file = { bytes, mime: part.mimetype };
    } else {
      if (
        ![...required, ...optional].includes(part.fieldname) ||
        Object.hasOwn(fields, part.fieldname) ||
        typeof part.value !== 'string' ||
        part.valueTruncated
      )
        throw new ApiError(400, 'Invalid or duplicate multipart fields.');
      fields[part.fieldname] = part.value;
    }
  }
  if (
    (requireFile && !file) ||
    required.some((key) => !Object.hasOwn(fields, key))
  )
    throw new ApiError(400, 'Missing submission fields or screenshot.');
  return { fields, file };
}
