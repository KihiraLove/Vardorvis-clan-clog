/** Local test edge: forward unchanged production responses onto browser loopback. */
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';

export function forward(request, response) {
  const upstream = httpRequest(
    {
      hostname: 'app',
      port: 8080,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: 'app:8080' },
    },
    (result) => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    },
  );
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
  response.on('close', () => upstream.destroy());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (
    process.env.SECURITY_PROXY_TEST !== '1' ||
    !/^clog-checks-[a-z0-9-]+$/u.test(process.env.COMPOSE_PROJECT_NAME ?? '')
  )
    throw new Error('Disposable local proxy tests only');
  createServer(forward).listen(5191, '127.0.0.1');
}
