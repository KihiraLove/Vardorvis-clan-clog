/** Public RuneLite intake and staff uploads share bounded multipart PNG handling. */
import { randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RequireAdmin } from './catalog-routes.js';
import { assetIdPattern } from './icon-storage.js';
import {
  runeLiteWorld,
  uuidPattern,
  screenshotPath,
  type ProofStore,
} from './proof-store.js';
import {
  screenshotParts as parts,
  screenshotLimits,
} from './screenshot-multipart.js';
import type { ManualSubmissionInput } from './review-types.js';
import type { ManualReviewStore, ProofFiles } from './route-services.js';
import { ApiError } from './types.js';
import { suppliedClanKey } from './clan-api-key.js';
import { runeLiteCors } from './runelite-cors.js';

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
          'collectionType',
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
    (row.collectionType !== undefined &&
      row.collectionType !== 'regular' &&
      row.collectionType !== 'event') ||
    (row.proofUrl !== undefined && row.proofUrl !== '') ||
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
    '/api/v1/admin/submission-images/:id.webp',
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
        .header('Content-Disposition', 'inline; filename="screenshot.webp"')
        .type('image/webp')
        .send(await storage.read(image));
    },
  );
  void app.register(async (scope) => {
    runeLiteCors(scope);
    await scope.register(multipart, {
      limits: screenshotLimits,
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
          ['chatMessage', 'itemName'],
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
          ...(fields.itemName === undefined
            ? {}
            : { itemName: fields.itemName }),
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
          try {
            const result = await review.createManual(
              input,
              actor.id,
              actor.displayName,
              key,
              image,
            );
            if (result.screenshotPath !== screenshotPath(image.id))
              await storage.remove?.(image.id).catch(() => {});
            return reply.code(201).send(result);
          } catch (error) {
            if (error instanceof ApiError && error.status < 500)
              await storage.remove?.(image.id).catch(() => {});
            // Preserve evidence when a commit outcome cannot be confirmed.
            throw error;
          }
        },
      );
  });
}
