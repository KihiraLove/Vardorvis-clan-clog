import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBotConfig } from './config.js';
import { registerFromEnv } from './register.js';

test('gateway and explicit registration consume secret files without requiring plaintext environment tokens', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'clog-bot-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gateway = join(root, 'gateway'),
    api = join(root, 'api');
  writeFileSync(gateway, 'fixture-discord-token\n');
  writeFileSync(api, 'a'.repeat(64) + '\n');
  const env = {
    DISCORD_BOT_TOKEN_FILE: gateway,
    BOT_API_TOKEN_FILE: api,
    DISCORD_GUILD_ID: '123456789012345678',
    DISCORD_APPLICATION_ID: '223456789012345678',
  };
  const config = readBotConfig(env)!;
  assert.equal(config.discordToken, 'fixture-discord-token');
  assert.equal(config.apiToken, 'a'.repeat(64));
  let requests = 0;
  await registerFromEnv('guild', env, async () => {
    requests++;
  });
  assert.equal(requests, 1);
  assert.throws(
    () => readBotConfig({ ...env, DISCORD_BOT_TOKEN: 'conflict' }),
    /Set only DISCORD_BOT_TOKEN/u,
  );
  assert.ok(!Object.hasOwn(env, 'DISCORD_BOT_TOKEN'));
});
