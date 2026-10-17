/** Both preview routes share account/global budgets; applies and replay do not. */
import { WorkBudget } from '@clog/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
export class PreviewWork {
  constructor(
    readonly budget = new WorkBudget({ concurrent: 2, perMinute: 12 }, [
      { concurrent: 1, perMinute: 4 },
    ]),
  ) {}
  async run<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    actor: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.budget.run([actor], async () => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      if (request.raw.aborted || reply.raw.destroyed) abort();
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(6500),
      ]);
      try {
        return await operation(signal);
      } finally {
        request.raw.off('aborted', abort);
        reply.raw.off('close', abort);
      }
    });
  }
}
