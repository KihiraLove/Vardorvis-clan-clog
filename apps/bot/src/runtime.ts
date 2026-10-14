/** Single listener survives discord.js gateway reconnects; shutdown blocks new work. */
import { Events, type Client, type Interaction } from 'discord.js';
import { type BotApi } from './api.js';
import { handleInteraction } from './handler.js';
import { BotWorkloads } from './workloads.js';
import {
  WorkDrain,
  OperationalDiagnostics,
  withinDeadline,
  safeFailure,
} from '@clog/domain';

type Gateway = Pick<Client, 'on' | 'isReady' | 'destroy'>;
export function wireGateway(
  client: Gateway,
  api: BotApi,
  guildId: string,
  workloads = new BotWorkloads(),
  options: { deadlineMs?: number; diagnostics?: OperationalDiagnostics } = {},
) {
  const work = new WorkDrain(),
    diagnostics = options.diagnostics ?? new OperationalDiagnostics('bot');
  let closing: Promise<boolean> | undefined;
  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    const release = work.enter(interaction.id);
    if (!release) return;
    void handleInteraction(interaction, api, guildId, workloads, diagnostics)
      .catch((error) =>
        diagnostics.record('failure', {
          operation: 'gateway',
          ...safeFailure(error),
          correlation: interaction.id,
        }),
      )
      .finally(release);
  });
  return {
    ready: () => !work.snapshot().stopping && client.isReady(),
    snapshot: () => ({
      ...work.snapshot(),
      intake: workloads.intake.snapshot(),
      search: workloads.search.snapshot(),
      counters: diagnostics.snapshot(),
    }),
    stop: () => {
      if (closing) return closing;
      const drained = work.stop();
      workloads.close();
      diagnostics.record('shutdown', {
        operation: 'runtime',
        code: 'DRAIN_STARTED',
        ...work.snapshot(),
      });
      closing = (async () => {
        const complete = await withinDeadline(
          () => drained,
          options.deadlineMs ?? 35000,
        );
        diagnostics.record('shutdown', {
          operation: 'runtime',
          code: complete ? 'DRAIN_COMPLETE' : 'DRAIN_EXPIRED',
          ...work.snapshot(),
        });
        await client.destroy();
        return complete;
      })();
      return closing;
    },
  };
}
