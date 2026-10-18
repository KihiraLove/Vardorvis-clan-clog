import { databaseUrl as runtimeDatabaseUrl } from '@clog/database/dist/secrets.js';
/** Real supervisor/proxy/API with a local gateway-health fixture; never connects to Discord. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import {
  mkdir,
  readFile,
  writeFile,
  chmod,
  unlink,
  open,
} from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { Events } from 'discord.js';
import {
  OperationalDiagnostics,
  withinDeadline,
} from './packages/domain/dist/index.js';
import { HttpBotApi } from './apps/bot/dist/api.js';
import { wireGateway } from './apps/bot/dist/runtime.js';
if (process.env.AVAILABILITY_SMOKE_DISPOSABLE !== 'true')
  throw Error('Disposable stack only.');
const token = process.env.BOT_API_TOKEN,
  guild = process.env.DISCORD_GUILD_ID;
assert.ok(token && guild);
const pool = new pg.Pool({
  connectionString: runtimeDatabaseUrl(
    process.env,
    process.env.POSTGRES_PASSWORD_FILE ? 'owner' : 'runtime',
  ),
});
const logPath = '/tmp/clog-availability.log';
// Nginx reopens /dev/stdout and /dev/stderr. Node's 'pipe' uses Unix sockets,
// which cannot be reopened that way; regular file descriptors model container logs.
const logFile = await open(logPath, 'a');
let main,
  exited,
  logs = '';
const until = async (check, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch {
      /* Startup/restart transition. */
    }
    await delay(50);
  }
  throw Error(
    'Availability fixture timed out: ' + (await readFile(logPath, 'utf8')),
  );
};
const read = async (path) => {
  const r = await fetch('http://127.0.0.1:8080' + path, {
    signal: AbortSignal.timeout(2500),
  });
  const text = await r.text();
  return { status: r.status, text };
};
async function start() {
  main = spawn('/usr/local/bin/start-app', [], {
    env: {
      ...process.env,
      PATH: '/tmp/clog-supervisor-bin:' + process.env.PATH,
    },
    stdio: ['ignore', logFile.fd, logFile.fd],
  });
  exited = new Promise((resolve) =>
    main.once('exit', (code, signal) => resolve({ code, signal })),
  );
  await until(async () => (await read('/readyz')).status === 200);
}
async function apiPid() {
  const children = (
    await readFile(
      '/proc/' + main.pid + '/task/' + main.pid + '/children',
      'utf8',
    )
  )
    .trim()
    .split(/\s+/u);
  for (const id of children)
    try {
      if (
        (await readFile('/proc/' + id + '/cmdline', 'utf8'))
          .split('\0')
          .includes('apps/api/dist/server.js')
      )
        return Number(id);
    } catch {
      /* Child just exited. */
    }
  throw Error('API child not found');
}
const waitExit = async () => {
  let timer;
  try {
    return await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error('Supervisor stop timed out')),
          12000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
try {
  await mkdir('/tmp/clog-supervisor-bin', { recursive: true });
  await writeFile(
    '/tmp/clog-supervisor-bin/node',
    `#!/usr/bin/env bash
if [[ "\${1:-}" == apps/bot/dist/index.js ]]; then exec /usr/local/bin/node /tmp/clog-fake-bot.mjs; fi
exec /usr/local/bin/node "$@"
`,
  );
  await chmod('/tmp/clog-supervisor-bin/node', 0o700);
  await writeFile(
    '/tmp/clog-fake-bot.mjs',
    `import fs from 'node:fs';import {createServer} from 'node:http';
fs.writeFileSync('/tmp/clog-fake-bot.pid',String(process.pid));
const server=createServer((req,res)=>{res.writeHead(req.url==='/healthz'||fs.existsSync('/tmp/clog-gateway-ready')?200:503);res.end('{}');});
server.listen(3001,'127.0.0.1');
setInterval(()=>{if(fs.existsSync('/tmp/clog-gateway-crash')){fs.unlinkSync('/tmp/clog-gateway-crash');process.exit(17);}},50);
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`,
  );
  await start();
  const api = await apiPid(),
    initialBot = await readFile('/tmp/clog-fake-bot.pid', 'utf8');
  assert.equal((await read('/api/v1/discord/status')).status, 503);
  assert.equal((await read('/readyz')).status, 200);
  assert.match((await read('/')).text, /<html/u);
  await writeFile('/tmp/clog-gateway-ready', '');
  await until(
    async () => (await read('/api/v1/discord/status')).status === 200,
  );
  await writeFile('/tmp/clog-gateway-crash', '');
  await until(
    async () =>
      (await readFile('/tmp/clog-fake-bot.pid', 'utf8')) !== initialBot,
  );
  assert.equal(await apiPid(), api);
  assert.equal((await read('/readyz')).status, 200);
  await until(
    async () => (await read('/api/v1/discord/status')).status === 200,
  );
  await unlink('/tmp/clog-gateway-ready');
  assert.equal((await read('/api/v1/discord/status')).status, 503);
  assert.equal((await read('/readyz')).status, 200);

  // A transport proxy pauses AFTER the real database commit. Both delivery outcomes
  // exercise the real bot HTTP retry/parser and handler against restricted-runtime API.
  const catalog = JSON.parse((await read('/api/v1/catalog')).text),
    item = catalog.items[0];
  for (const uncertain of [false, true]) {
    const id = uncertain ? '345678901234568902' : '345678901234568901';
    let release,
      observed,
      posted,
      stored,
      attempts = 0;
    const gate = new Promise((resolve) => {
        release = resolve;
      }),
      captured = new Promise((resolve) => {
        observed = resolve;
      });
    const proxy = createServer((request, response) => {
      void (async () => {
        if (++attempts > 1 && uncertain) {
          response.writeHead(429);
          response.end('{}');
          return;
        }
        let body = '';
        for await (const chunk of request) body += chunk;
        posted = JSON.parse(body);
        const upstream = await fetch(
          'http://127.0.0.1:3000/api/v1/bot/submissions',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + token,
              'Content-Type': 'application/json',
            },
            body,
          },
        );
        const text = await upstream.text();
        assert.equal(upstream.status, 201, text);
        stored = JSON.parse(text);
        observed();
        await gate;
        if (uncertain) response.destroy();
        else {
          response.writeHead(201, { 'Content-Type': 'application/json' });
          response.end(text);
        }
      })().catch(() => response.destroy());
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    class Gateway extends EventEmitter {
      destroyed = 0;
      isReady() {
        return true;
      }
      destroy() {
        this.destroyed++;
      }
    }
    const client = new Gateway(),
      records = [],
      messages = [];
    const runtime = wireGateway(
      client,
      new HttpBotApi('http://127.0.0.1:' + proxy.address().port, token),
      guild,
      undefined,
      {
        deadlineMs: 5000,
        diagnostics: new OperationalDiagnostics('bot', (r) => records.push(r)),
      },
    );
    let acknowledge;
    const ack = new Promise((resolve) => {
      acknowledge = resolve;
    });
    const interaction = {
      id,
      guildId: guild,
      user: { id: '123456789012345678', username: 'FixtureReceipt' },
      member: null,
      commandName: 'cc-clog',
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
      options: {
        getSubcommand: () => 'submit',
        getString: (key) =>
          key === 'item'
            ? 'item:' + item.id
            : key === 'proof'
              ? 'https://imgur.com/a/shutdown-fixture'
              : null,
        getBoolean: () => false,
      },
      deferReply: async () => {},
      editReply: async (message) => {
        messages.push(message);
        await ack;
      },
    };
    try {
      client.emit(Events.InteractionCreate, interaction);
      assert.equal(
        await withinDeadline(() => captured, 10000),
        true,
        'Committed response fixture did not become ready',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM submissions WHERE discord_interaction_id=$1',
            [id],
          )
        ).rows[0].n,
        1,
      );
      const stopped = runtime.stop();
      assert.equal(client.destroyed, 0);
      release();
      await until(async () => messages.length === 1);
      assert.equal(client.destroyed, 0);
      acknowledge();
      assert.equal(await stopped, true);
      assert.equal(client.destroyed, 1);
      if (uncertain) {
        assert.match(messages[0], /could not be confirmed/u);
        assert.doesNotMatch(
          messages[0],
          /Nothing was saved|Saved for admin review/u,
        );
        assert.ok(records.some((r) => r.category === 'uncertain'));
      } else {
        assert.match(messages[0], new RegExp(stored.submissionId, 'u'));
        assert.ok(
          records.some(
            (r) =>
              r.receipt === stored.submissionId && r.code === 'RECEIPT_KNOWN',
          ),
        );
      }
      const replay = await new HttpBotApi(
        'http://127.0.0.1:3000',
        token,
      ).submit(posted);
      assert.equal(replay.submissionId, stored.submissionId);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM submissions WHERE discord_interaction_id=$1',
            [id],
          )
        ).rows[0].n,
        1,
      );
    } finally {
      release();
      acknowledge();
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    }
  }
  main.kill('SIGTERM');
  main.kill('SIGTERM');
  assert.deepEqual(await waitExit(), { code: 0, signal: null });
  logs = await readFile(logPath, 'utf8');
  assert.match(logs, /DRAIN_COMPLETE/u);
  // A critical API crash still tears down the unified application with failure.
  await start();
  process.kill(await apiPid(), 'SIGKILL');
  assert.notEqual((await waitExit()).code, 0);
  logs = await readFile(logPath, 'utf8');
  assert.doesNotMatch(logs, new RegExp(token, 'u'));
  assert.doesNotMatch(logs, /postgresql:|imgur\.com|FixtureReceipt/u);
  console.log(
    'Website remains ready across gateway outage/recovery and bot-only restart; shutdown drains committed/unconfirmed receipts and critical crashes fail closed.',
  );
} catch (error) {
  // The fixture redirects children to a regular file so Nginx can reopen its
  // streams. Include that evidence in smoke.log and the CI failure artifact.
  const evidence = await readFile(logPath, 'utf8').catch(
    () => 'Supervisor log unavailable.',
  );
  console.error(
    'Availability supervisor log:\n' + evidence.replaceAll(token, '[redacted]'),
  );
  throw error;
} finally {
  if (main && main.exitCode === null) {
    main.kill('SIGTERM');
    await waitExit().catch(() => main.kill('SIGKILL'));
  }
  await pool.end();
  await logFile.close();
}
