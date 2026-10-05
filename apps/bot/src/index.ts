import { createServer } from 'node:http';
import { collectionLogCommand } from './command.js';

// A runnable image for infrastructure validation; no Discord login or fake submission success.
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url !== '/healthz') {
    response.writeHead(404);
    response.end('{}');
    return;
  }
  response.end(
    JSON.stringify({
      status: 'ok',
      stage: 'foundation',
      discordConnected: false,
    }),
  );
});
server.listen(3001, '0.0.0.0');
console.log(
  `Bot foundation started; /${collectionLogCommand.name} submit is defined but not registered or accepting submissions`,
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close();
  });
