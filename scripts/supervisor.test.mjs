/** Exercise the real Bash supervisor against isolated controllable child processes. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
const childScript = String.raw`#!/usr/bin/env bash
set -uo pipefail
kind=proxy
if [[ "$1" == apps/api/dist/server.js ]]; then kind=api; fi
if [[ "$1" == apps/bot/dist/index.js ]]; then kind=bot; fi
printf '%s\n' "$$" > "$FIXTURE/$kind.pid"
printf '%s\n' "$kind:start:$$" >> "$FIXTURE/events"
stop() {
  trap '' TERM INT QUIT
  if [[ -f "$FIXTURE/$kind.ignore" ]]; then return; fi
  printf '%s\n' "$kind:stop" >> "$FIXTURE/events"
  while [[ -f "$FIXTURE/$kind.hold" && ! -f "$FIXTURE/$kind.release" ]]; do sleep 0.03; done
  printf '%s\n' "$kind:done" >> "$FIXTURE/events"
  if [[ -f "$FIXTURE/$kind.exit" ]]; then exit "$(cat "$FIXTURE/$kind.exit")"; fi
  exit 0
}
trap stop TERM INT QUIT
while true; do
  if [[ -f "$FIXTURE/$kind.crash" ]]; then exit 23; fi
  sleep 0.03
done
`;
const proxyScript = `#!/usr/local/bin/node
const fs=require('node:fs'),dir=process.env.FIXTURE;
fs.writeFileSync(dir+'/proxy.pid',String(process.pid));
fs.appendFileSync(dir+'/events','proxy:start:'+process.pid+'\\n');
let stopped=false;
const stop=()=>{if(stopped)return;stopped=true;fs.appendFileSync(dir+'/events','proxy:stop\\nproxy:done\\n');process.exit(fs.existsSync(dir+'/proxy.exit')?Number(fs.readFileSync(dir+'/proxy.exit','utf8')):0);};
process.on('SIGQUIT',stop);process.on('SIGTERM',stop);
setInterval(()=>{},1000);
`;
async function fixture(run, enabled = true) {
  const dir = await mkdtemp(join(tmpdir(), 'clog-supervisor-'));
  let supervisor,
    logs = '';
  const state = async () => {
    try {
      return await readFile(join(dir, 'events'), 'utf8');
    } catch {
      return '';
    }
  };
  const until = async (check, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await delay(30);
    }
    throw Error('Supervisor fixture timeout: ' + (await state()) + ' ' + logs);
  };
  try {
    await writeFile(join(dir, 'node'), childScript, { mode: 0o700 });
    await writeFile(join(dir, 'nginx'), proxyScript, { mode: 0o700 });
    supervisor = spawn('bash', [resolve('infra/start-app.sh')], {
      env: {
        ...process.env,
        PATH: dir + ':' + process.env.PATH,
        FIXTURE: dir,
        BOT_ENABLED: String(enabled),
        DISCORD_BOT_TOKEN: 'fixture',
        DISCORD_GUILD_ID: 'fixture',
        BOT_API_TOKEN: 'fixture',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    supervisor.stdout.on('data', (s) => {
      logs += s;
    });
    supervisor.stderr.on('data', (s) => {
      logs += s;
    });
    const exit = new Promise((resolve) =>
      supervisor.once('exit', (code, signal) => resolve({ code, signal })),
    );
    await until(async () => {
      const s = await state();
      return (
        s.includes('api:start') &&
        s.includes('proxy:start') &&
        (!enabled || s.includes('bot:start'))
      );
    });
    await run({
      dir,
      state,
      until,
      supervisor,
      exit,
      pid: async (kind) =>
        Number((await readFile(join(dir, kind + '.pid'), 'utf8')).trim()),
      logs: () => logs,
    });
  } finally {
    if (supervisor && supervisor.exitCode === null) {
      supervisor.kill('SIGTERM');
      await delay(100);
      supervisor.kill('SIGKILL');
    }
    for (const kind of ['api', 'bot', 'proxy']) {
      try {
        process.kill(
          Number((await readFile(join(dir, kind + '.pid'), 'utf8')).trim()),
          'SIGKILL',
        );
      } catch {
        /* Already stopped. */
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}
test(
  'supervisor drains bot before API and proxy, tolerates repeated signals and exits cleanly',
  { skip: process.platform === 'win32', timeout: 15000 },
  async () =>
    fixture(async (f) => {
      await writeFile(join(f.dir, 'bot.hold'), '');
      await writeFile(join(f.dir, 'api.hold'), '');
      f.supervisor.kill('SIGTERM');
      await f.until(async () => (await f.state()).includes('bot:stop'));
      f.supervisor.kill('SIGTERM');
      await delay(100);
      assert.doesNotMatch(await f.state(), /api:stop|proxy:stop/u);
      await writeFile(join(f.dir, 'bot.release'), '');
      await f.until(async () => (await f.state()).includes('api:stop'));
      assert.doesNotMatch(await f.state(), /proxy:stop/u);
      await writeFile(join(f.dir, 'api.release'), '');
      assert.deepEqual(await f.exit, { code: 0, signal: null });
      const events = await f.state();
      assert.ok(events.indexOf('bot:done') < events.indexOf('api:stop'));
      assert.ok(events.indexOf('api:done') < events.indexOf('proxy:stop'));
    }),
);
test(
  'shutdown reports each failed child and still drains the remaining components',
  { skip: process.platform === 'win32', timeout: 15000 },
  async () => {
    for (const component of ['bot', 'api', 'proxy'])
      await fixture(async (f) => {
        await writeFile(join(f.dir, component + '.exit'), '23');
        f.supervisor.kill('SIGTERM');
        assert.deepEqual(await f.exit, { code: 1, signal: null });
        assert.match(
          f.logs(),
          new RegExp(
            `"component":"${component}","code":"DRAIN_FAILED","status":23`,
            'u',
          ),
        );
        for (const child of ['bot', 'api', 'proxy'])
          assert.match(await f.state(), new RegExp(child + ':done', 'u'));
      });
  },
);

test(
  'a bot crash restarts only the bot with backoff while the website stays alive',
  { skip: process.platform === 'win32', timeout: 15000 },
  async () =>
    fixture(async (f) => {
      const api = await f.pid('api'),
        proxy = await f.pid('proxy'),
        bot = await f.pid('bot');
      process.kill(bot, 'SIGKILL');
      await f.until(async () => (await f.pid('bot')) !== bot);
      assert.equal(await f.pid('api'), api);
      assert.equal(await f.pid('proxy'), proxy);
      assert.doesNotMatch(await f.state(), /api:stop|proxy:stop/u);
      assert.match(f.logs(), /"retrySeconds":1/u);
      const restarted = await f.pid('bot');
      process.kill(restarted, 'SIGKILL');
      await f.until(async () => (await f.pid('bot')) !== restarted);
      assert.match(f.logs(), /"retrySeconds":2/u);
      f.supervisor.kill('SIGTERM');
      assert.deepEqual(await f.exit, { code: 0, signal: null });
    }),
);
test(
  'critical API crash stops peers and returns failure, while disabled bot mode starts no gateway',
  { skip: process.platform === 'win32', timeout: 15000 },
  async () => {
    for (const critical of ['api', 'proxy'])
      await fixture(async (f) => {
        process.kill(await f.pid(critical), 'SIGKILL');
        const result = await f.exit;
        assert.notEqual(result.code, 0);
        assert.match(await f.state(), /bot:done/u);
        assert.match(
          await f.state(),
          critical === 'api' ? /proxy:done/u : /api:done/u,
        );
      });
    await fixture(async (f) => {
      assert.doesNotMatch(await f.state(), /bot:start/u);
      f.supervisor.kill('SIGTERM');
      assert.deepEqual(await f.exit, { code: 0, signal: null });
    }, false);
  },
);

test(
  'settings reload restarts only the bot without accumulating crash backoff',
  { skip: process.platform === 'win32', timeout: 15000 },
  async () =>
    fixture(async (f) => {
      const api = await f.pid('api'),
        proxy = await f.pid('proxy');
      for (let i = 0; i < 3; i++) {
        const bot = await f.pid('bot');
        process.kill(bot, 'SIGTERM');
        await f.until(async () => (await f.pid('bot')) !== bot);
      }
      assert.equal(await f.pid('api'), api);
      assert.equal(await f.pid('proxy'), proxy);
      assert.equal(
        (f.logs().match(/"code":"CONFIGURATION_RELOAD"/gu) ?? []).length,
        3,
      );
      assert.doesNotMatch(f.logs(), /"retrySeconds":[2-9]/u);
      f.supervisor.kill('SIGTERM');
      assert.deepEqual(await f.exit, { code: 0, signal: null });
    }),
);
test(
  'shutdown cancels bot restart backoff without resurrecting the stopped child',
  { skip: process.platform === 'win32', timeout: 10000 },
  async () =>
    fixture(async (f) => {
      process.kill(await f.pid('bot'), 'SIGKILL');
      await f.until(async () => f.logs().includes('"retrySeconds":1'));
      f.supervisor.kill('SIGTERM');
      assert.deepEqual(await f.exit, { code: 0, signal: null });
      await delay(1100);
      assert.equal((await f.state()).match(/bot:start/gu).length, 1);
    }),
);
test(
  'supervisor forces a stuck API at its real deadline and reports failure instead of hanging',
  { skip: process.platform === 'win32', timeout: 30000 },
  async () =>
    fixture(async (f) => {
      await writeFile(join(f.dir, 'api.ignore'), '');
      const start = Date.now();
      f.supervisor.kill('SIGTERM');
      const result = await f.exit;
      assert.notEqual(result.code, 0);
      assert.ok(Date.now() - start < 26000);
      assert.match(f.logs(), /"component":"api","code":"DRAIN_EXPIRED"/u);
    }, false),
);
