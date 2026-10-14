/** Single listener survives discord.js gateway reconnects; shutdown blocks new work. */
import { Events, type Client, type Interaction } from 'discord.js';
import { type BotApi } from './api.js';
import { handleInteraction } from './handler.js';
import { BotWorkloads } from './workloads.js';

type Gateway = Pick<Client, 'on' | 'isReady' | 'destroy'>;
export function wireGateway(
  client: Gateway,
  api: BotApi,
  guildId: string,
  workloads = new BotWorkloads(),
) {
  let stopping = false;
  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    if (stopping) return;
    void handleInteraction(interaction, api, guildId, workloads).catch(() => {
      // Interactions may expire during a disconnect. No false receipt is sent.
    });
  });
  return {
    ready: () => !stopping && client.isReady(),
    stop: () => {
      if (stopping) return;
      stopping = true;
      workloads.close();
      client.destroy();
    },
  };
}
