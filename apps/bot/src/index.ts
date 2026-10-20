/** Discord gateway adapter with explicit disabled mode and graceful shutdown. */
import { createServer } from 'node:http';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { HttpBotApi } from './api.js';
import { readBotConfig } from './config.js';
import { loadSavedConfiguration, watchConfiguration } from './saved-config.js';
import { wireGateway } from './runtime.js';
import { cachedReadiness } from './readiness.js';
import { BotWorkloads, readWorkloadLimits } from './workloads.js';

import {
  OperationalDiagnostics,
  withinDeadline,
  safeFailure,
} from '@clog/domain';
const diagnostics = new OperationalDiagnostics('bot', (record) =>
  process.stderr.write(JSON.stringify(record) + '\n'),
);
function fatal(error: unknown) {
  diagnostics.record('process', {
    operation: 'runtime',
    ...safeFailure(error),
    code: 'PROCESS_FAILED',
  });
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
async function main() {
  const saved =
    process.env.BOT_SETTINGS_MODE === 'database'
      ? await loadSavedConfiguration()
      : undefined;
  const config =
    process.env.BOT_SETTINGS_MODE === 'disabled'
      ? null
      : saved
        ? saved.config
        : readBotConfig();
  const client = config
    ? new Client({ intents: [GatewayIntentBits.Guilds] })
    : null;
  const api = config ? new HttpBotApi(config.apiOrigin, config.apiToken) : null;
  const runtime =
    config && client && api
      ? wireGateway(
          client,
          api,
          config.guildId,
          new BotWorkloads(saved?.saved.limits ?? readWorkloadLimits()),
          { diagnostics },
        )
      : null;
  const apiReady = api
    ? cachedReadiness(() => api.checkReady())
    : async () => false;
  let stopping = false;
  let wasReady: boolean | undefined;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/metrics') {
      response.end(
        JSON.stringify(
          runtime?.snapshot() ?? {
            counters: diagnostics.snapshot(),
            active: 0,
          },
        ),
      );
      return;
    }
    if (request.url !== '/healthz' && request.url !== '/readyz') {
      response.writeHead(404);
      response.end('{}');
      return;
    }
    const discordConnected = runtime?.ready() ?? false;
    if (request.url === '/healthz') {
      // Liveness stays available in intentionally disabled test mode.
      response.writeHead(200);
      response.end(
        JSON.stringify({
          status: stopping ? 'stopping' : config ? 'running' : 'disabled',
          discordConfigured: !!config,
          discordConnected,
          connectionState: runtime?.connectionState() ?? 'disabled',
        }),
      );
      return;
    }
    // A live /readyz checks BOTH the Discord gateway and the authenticated
    // database-backed bot intake route; failures never imply readiness.
    void (async () => {
      const apiConnected = !stopping && discordConnected && (await apiReady());
      const ready = !stopping && (runtime?.ready() ?? false) && apiConnected;
      if (wasReady !== ready)
        diagnostics.record('readiness', {
          operation: 'readiness',
          code: ready ? 'READY' : 'NOT_READY',
        });
      wasReady = ready;
      response.writeHead(ready ? 200 : 503);
      response.end(
        JSON.stringify({
          status: ready ? 'ready' : 'not-ready',
          discordConfigured: !!config,
          discordConnected: runtime?.ready() ?? false,
          apiConnected,
          connectionState: runtime?.connectionState() ?? 'disabled',
        }),
      );
    })().catch(() => {
      response.writeHead(503);
      response.end('{"status":"not-ready"}');
    });
  });
  let closing: Promise<void> | undefined;
  let stopWatching: (() => void) | undefined;
  function shutdown(exitCode = 0) {
    if (exitCode) process.exitCode = exitCode;
    if (closing) return closing;
    stopping = true;
    stopWatching?.();
    closing = (async () => {
      let drained = true;
      const complete = await withinDeadline(async () => {
        drained = (await runtime?.stop()) ?? true;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await saved?.pool.end();
      }, 37000);
      if (!complete || !drained) {
        diagnostics.record('shutdown', {
          operation: 'runtime',
          code: 'DRAIN_EXPIRED',
          pending: runtime?.snapshot().pending ?? [],
        });
        server.closeAllConnections();
        process.exit(1);
      }
    })();
    return closing;
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      void shutdown().catch(fatal);
    });
  server.listen(3001, '0.0.0.0');
  if (saved)
    stopWatching = watchConfiguration(
      saved.saved.revision,
      () => saved.store.settings(),
      () => shutdown(),
      () => shutdown(1),
    );
  if (client && config) {
    client.on(Events.Error, (error) => {
      diagnostics.record('failure', {
        operation: 'gateway',
        ...safeFailure(error),
      });
    });
    client.on(Events.ClientReady, () => {
      diagnostics.record('process', {
        operation: 'gateway',
        code: 'GATEWAY_CONNECTED',
      });
    });
    try {
      await client.login(config.discordToken);
    } catch (error) {
      if (!stopping)
        diagnostics.record('failure', {
          operation: 'gateway',
          ...safeFailure(error),
        });
      await shutdown(stopping ? 0 : 1);
    }
  } else {
    console.log(
      'Discord bot disabled: configure credentials to enable gateway commands.',
    );
  }
}
void main().catch(fatal);
