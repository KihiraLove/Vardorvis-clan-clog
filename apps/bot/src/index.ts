/** Discord gateway adapter with explicit disabled mode and graceful shutdown. */
import { createServer } from 'node:http';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { HttpBotApi } from './api.js';
import { readBotConfig } from './config.js';
import { wireGateway } from './runtime.js';

const config = readBotConfig();
const client = config
  ? new Client({ intents: [GatewayIntentBits.Guilds] })
  : null;
const runtime =
  config && client
    ? wireGateway(
        client,
        new HttpBotApi(config.apiOrigin, config.apiToken),
        config.guildId,
      )
    : null;
let stopping = false;
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  if (request.url !== '/healthz' && request.url !== '/readyz') {
    response.writeHead(404);
    response.end('{}');
    return;
  }
  const discordConnected = runtime?.ready() ?? false;
  const ready = !stopping && discordConnected;
  response.writeHead(request.url === '/readyz' && !ready ? 503 : 200);
  response.end(
    JSON.stringify({
      status: stopping ? 'stopping' : config ? 'running' : 'disabled',
      discordConfigured: !!config,
      discordConnected,
    }),
  );
});
async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  runtime?.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (exitCode) process.exitCode = exitCode;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void shutdown();
  });
server.listen(3001, '0.0.0.0');
if (client && config) {
  client.on(Events.Error, () => {
    console.error(
      'Discord gateway error; connection will be retried by discord.js.',
    );
  });
  client.on(Events.ClientReady, () => {
    console.log(
      'Discord gateway connected; bot is ready for guild-only commands.',
    );
  });
  try {
    await client.login(config.discordToken);
  } catch {
    console.error(
      'Discord gateway login failed; bot will exit without accepting commands.',
    );
    await shutdown(1);
  }
} else {
  console.log(
    'Discord bot disabled: configure credentials to enable gateway commands.',
  );
}
