import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CollectionScheduleInput } from '@clog/domain';
import type { SchedulingStore } from './scheduling-store.js';
import { ApiError, type AdminIdentity, type StaffAccount } from './types.js';
const revision = {
  type: 'string',
  pattern: '^schedules-[1-9][0-9]*$',
  maxLength: 30,
};
const scheduleBody = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedRevision', 'title', 'startsAt', 'endsAt', 'pageIds'],
  properties: {
    expectedRevision: revision,
    title: { type: 'string', minLength: 1, maxLength: 100 },
    startsAt: { type: 'string', maxLength: 24 },
    endsAt: { type: 'string', maxLength: 24 },
    pageIds: {
      type: 'array',
      minItems: 1,
      maxItems: 200,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 100 },
    },
  },
};
export function schedulingRoutes(
  app: FastifyInstance,
  store?: SchedulingStore,
  authorize?: (
    request: FastifyRequest,
    write?: boolean,
  ) => Promise<AdminIdentity & Pick<StaffAccount, 'role'>>,
) {
  const staff = async (request: FastifyRequest, write = false) => {
    if (!authorize) throw new ApiError(503, 'Staff sign-in is not configured.');
    return authorize(request, write);
  };
  const available = () => {
    if (!store) throw new ApiError(503, 'Scheduling unavailable.');
    return store;
  };
  app.get('/api/v1/admin/schedules', async (request) => {
    await staff(request);
    return available().state();
  });
  app.put<{ Body: { enabled: boolean; expectedRevision: string } }>(
    '/api/v1/admin/schedules/settings',
    {
      onRequest: async (request) => {
        const actor = await staff(request, true);
        if (actor.role !== 'admin')
          throw new ApiError(
            403,
            'Only the administrator can enable or disable scheduling.',
          );
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled', 'expectedRevision'],
          properties: {
            enabled: { type: 'boolean' },
            expectedRevision: revision,
          },
        },
      },
    },
    async (request) => {
      const actor = await staff(request, true);
      return available().setEnabled(
        request.body.enabled,
        request.body.expectedRevision,
        actor.id,
        actor.displayName,
      );
    },
  );
  app.put<{ Body: { pageIds: string[]; expectedRevision: string } }>(
    '/api/v1/admin/schedules/permanent-pages',
    {
      onRequest: async (request) => {
        await staff(request, true);
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['pageIds', 'expectedRevision'],
          properties: {
            expectedRevision: revision,
            pageIds: {
              type: 'array',
              maxItems: 2000,
              uniqueItems: true,
              items: { type: 'string', minLength: 1, maxLength: 100 },
            },
          },
        },
      },
    },
    async (request) => {
      const actor = await staff(request, true);
      return available().setPermanentPages(
        request.body.pageIds,
        request.body.expectedRevision,
        actor.id,
        actor.displayName,
      );
    },
  );
  app.post<{ Body: CollectionScheduleInput & { expectedRevision: string } }>(
    '/api/v1/admin/schedules',
    {
      onRequest: async (request) => {
        await staff(request, true);
      },
      schema: { body: scheduleBody },
    },
    async (request, reply) => {
      const actor = await staff(request, true);
      const { expectedRevision, ...input } = request.body;
      return reply
        .code(201)
        .send(
          await available().save(
            input,
            expectedRevision,
            actor.id,
            actor.displayName,
          ),
        );
    },
  );
  app.put<{
    Params: { id: string };
    Body: CollectionScheduleInput & { expectedRevision: string };
  }>(
    '/api/v1/admin/schedules/:id',
    {
      onRequest: async (request) => {
        await staff(request, true);
      },
      schema: { body: scheduleBody },
    },
    async (request) => {
      const actor = await staff(request, true);
      const { expectedRevision, ...input } = request.body;
      return available().save(
        input,
        expectedRevision,
        actor.id,
        actor.displayName,
        request.params.id,
      );
    },
  );
  app.delete<{ Params: { id: string }; Body: { expectedRevision: string } }>(
    '/api/v1/admin/schedules/:id',
    {
      onRequest: async (request) => {
        await staff(request, true);
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedRevision'],
          properties: { expectedRevision: revision },
        },
      },
    },
    async (request) => {
      const actor = await staff(request, true);
      return available().remove(
        request.params.id,
        request.body.expectedRevision,
        actor.id,
        actor.displayName,
      );
    },
  );
}
