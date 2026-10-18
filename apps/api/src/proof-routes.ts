/** Public RuneLite intake and staff uploads share bounded multipart PNG handling. */
import { randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RequireAdmin } from './catalog-routes.js';
import { assetIdPattern } from './icon-storage.js';
import { runeLiteWorld, uuidPattern, type ProofStore } from './proof-store.js';
import { MAX_SCREENSHOT_BYTES } from './proof-storage.js';
import type { ManualSubmissionInput } from './review-types.js';
import type { ManualReviewStore, ProofFiles } from './route-services.js';
import { ApiError } from './types.js';
import { suppliedClanKey } from './clan-api-key.js';
import { runeLiteCors } from './runelite-cors.js';

async function parts(
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
function requestKey(request: FastifyRequest, required: boolean) {
  const value = request.headers['idempotency-key'];
  if (value === undefined && !required) return randomUUID();
  if (typeof value !== 'string' || !uuidPattern.test(value))
    throw new ApiError(400, 'Use a UUID Idempotency-Key.');
  return value.toLowerCase();
}
function manualFields(json: string): ManualSubmissionInput {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ApiError(400, 'Invalid submission JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'Invalid submission fields.');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (k) =>
        ![
          'itemId',
          'collectorName',
          'collectedOn',
          'hardcore',
          'approve',
          'proofUrl',
          'reason',
        ].includes(k),
    ) ||
    !Number.isSafeInteger(row.itemId) ||
    Number(row.itemId) < 1 ||
    Number(row.itemId) > 2147483647 ||
    typeof row.collectorName !== 'string' ||
    row.collectorName.length > 80 ||
    !row.collectorName.trim() ||
    typeof row.collectedOn !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(row.collectedOn) ||
    typeof row.hardcore !== 'boolean' ||
    typeof row.approve !== 'boolean' ||
    (row.proofUrl !== undefined &&
      (typeof row.proofUrl !== 'string' || row.proofUrl.length > 2048)) ||
    (row.reason !== undefined &&
      (typeof row.reason !== 'string' || row.reason.length > 1000))
  )
    throw new ApiError(400, 'Invalid submission fields.');
  return row as unknown as ManualSubmissionInput;
}
export function proofRoutes(
  app: FastifyInstance,
  store: ProofStore,
  storage: ProofFiles,
  review?: ManualReviewStore,
  authorize?: RequireAdmin,
) {
  const staff = async (request: FastifyRequest, write = false) => {
    if (!authorize) throw new ApiError(503, 'Staff sign-in is not configured.');
    return authorize(request, write);
  };
  // If commit acknowledgement was lost, retain the file unless absence is confirmed.
  // Never unlink a saved file based on an uncertain database receipt.
  // Offline, reference-checked maintenance reclaims orphaned uploads.
  app.get<{ Params: { id: string } }>(
    '/api/v1/admin/submission-images/:id.png',
    {
      onRequest: async (req) => {
        await staff(req);
      },
    },
    async (req, reply) => {
      if (!assetIdPattern.test(req.params.id))
        throw new ApiError(404, 'Screenshot not found.');
      const image = await store.image(req.params.id);
      if (!image) throw new ApiError(404, 'Screenshot not found.');
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('Content-Disposition', 'inline; filename="screenshot.png"')
        .type('image/png')
        .send(await storage.read(image));
    },
  );
  void app.register(async (scope) => {
    runeLiteCors(scope);
    await scope.register(multipart, {
      limits: {
        fileSize: MAX_SCREENSHOT_BYTES,
        files: 1,
        fields: 5,
        parts: 6,
        fieldSize: 8193,
      },
    });
    scope.post(
      '/api/v1/runelite/submissions',
      {
        onRequest: async (req) => {
          if (!(await store.allowIntake(req.ip)))
            throw new ApiError(
              429,
              'Submission rate limit reached. Try again later.',
            );
          await store.authorizeIntake(suppliedClanKey(req.headers));
        },
      },
      async (req, reply) => {
        const key = requestKey(req, false);
        const { fields, file } = await parts(
          req,
          ['username', 'clanName', 'itemId', 'worldType'],
          ['chatMessage'],
          false,
        );
        if (
          !fields.username!.trim() ||
          fields.username!.length > 80 ||
          !fields.clanName!.trim() ||
          fields.clanName!.length > 80 ||
          !/^[1-9][0-9]{0,9}$/u.test(fields.itemId!) ||
          Number(fields.itemId) > 2147483647
        )
          throw new ApiError(
            422,
            'Invalid username, clan name or game item ID.',
          );
        const world = runeLiteWorld(fields.worldType!);
        const submission = {
          username: fields.username!,
          clanName: fields.clanName!,
          itemId: Number(fields.itemId),
          worldTypes: world.worldTypes,
          ...(fields.chatMessage === undefined
            ? {}
            : { chatMessage: fields.chatMessage }),
        };
        await store.validateSubmission(submission);
        const image = file
          ? await storage.save(file.bytes, file.mime)
          : undefined;
        // Commit outcome may be uncertain: preserve the file for maintenance.
        const result = await store.createRuneLite(
          submission,
          image,
          key,
          suppliedClanKey(req.headers),
        );
        // A committed duplicate receipt confirms this new file is unreferenced.
        // Uncertain commits still retain evidence for reference-checked maintenance.
        if (image && result.receipt.duplicate && result.imageId !== image.id)
          await storage.remove?.(image.id).catch(() => {});
        return reply.code(201).send(result.receipt);
      },
    );
    if (review)
      scope.post(
        '/api/v1/admin/submissions/upload',
        {
          onRequest: async (req) => {
            await staff(req, true);
          },
        },
        async (req, reply) => {
          const actor = await staff(req, true);
          const key = requestKey(req, true);
          const { fields, file } = await parts(req, ['submission']);
          const input = manualFields(fields.submission!);
          if (!file) throw new ApiError(400, 'Supply one screenshot file.');
          const image = await storage.save(file.bytes, file.mime);
          // Commit outcome may be uncertain: preserve the file for maintenance.
          const result = await review.createManual(
            input,
            actor.id,
            actor.displayName,
            key,
            image,
          );
          // A replay may leave an orphan; maintenance reclaims it later.
          return reply.code(201).send(result);
        },
      );
  });
}
