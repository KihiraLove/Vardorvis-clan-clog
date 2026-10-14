import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { Events, type Client, type Interaction } from 'discord.js';
import { OperationalDiagnostics, WorkloadError } from '@clog/domain';
import { wireGateway } from './runtime.js';
import {
  type BotApi,
  type Receipt,
  botFailure,
  BotApiError,
  UnconfirmedSubmissionError,
} from './api.js';
const id = '345678901234567890',
  guild = '234567890123456789';
const receipt: Receipt = {
  submissionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  interactionId: id,
  status: 'pending',
  submittedAt: '2026-10-14T10:00:00Z',
  collectedOn: '2026-10-14',
  dateSource: 'submission_default',
  hardcore: false,
  resolution: 'resolved',
  itemId: 42,
  candidates: [],
  creditOccupied: false,
};
class Gateway extends EventEmitter {
  destroyed = 0;
  isReady() {
    return true;
  }
  destroy() {
    this.destroyed++;
  }
}
function command(
  editReply: (message: string) => Promise<void>,
  deferReply = async () => {},
) {
  return {
    id,
    guildId: guild,
    user: { id: '123456789012345678', username: 'private' },
    member: null,
    commandName: 'cc-clog',
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    deferReply,
    editReply,
    options: {
      getSubcommand: () => 'submit',
      getString: (key: string) =>
        ({
          item: 'Item',
          proof: 'https://imgur.com/a/private',
          'submitter-name': null,
        })[key as 'item'],
      getBoolean: () => false,
    },
  } as unknown as Interaction;
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
test(
  'bot process keeps handling repeated termination signals while its health server drains',
  { skip: process.platform === 'win32', timeout: 10000 },
  async () => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { Server } from 'node:http';
         const listen = Server.prototype.listen, close = Server.prototype.close;
         Server.prototype.listen = function () {
           this.once('listening', () => console.log('fixture-listening'));
           return listen.call(this, 0, '127.0.0.1');
         };
         Server.prototype.close = function (callback) {
           console.log('fixture-draining');
           setTimeout(() => close.call(this, callback), 250);
           return this;
         };
         await import(${JSON.stringify(new URL('./index.js', import.meta.url).href)});`,
      ],
      {
        env: {
          ...process.env,
          DISCORD_BOT_TOKEN: '',
          DISCORD_GUILD_ID: '',
          BOT_API_TOKEN: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = once(child, 'exit');
    const marker = async (value: string) => {
      const deadline = Date.now() + 5000;
      while (!output.includes(value)) {
        assert.equal(child.exitCode, null, output);
        assert.equal(child.signalCode, null, output);
        assert.ok(Date.now() < deadline, output);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      await marker('fixture-listening');
      child.kill('SIGTERM');
      await marker('fixture-draining');
      child.kill('SIGTERM');
      assert.deepEqual(await exited, [0, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    }
  },
);
test('bot diagnostics distinguish local overload, upstream authentication and uncertain retries', () => {
  assert.equal(botFailure(new WorkloadError()).category, 'overload');
  assert.equal(botFailure(new BotApiError(401)).category, 'auth');
  assert.equal(botFailure(new BotApiError(403)).category, 'forbidden');
  assert.equal(
    botFailure(new UnconfirmedSubmissionError(id, 'retry-rejected')).category,
    'uncertain',
  );
});
test('gateway stop drains a committed receipt and delayed Discord acknowledgement, rejecting new work until destroy', async () => {
  const client = new Gateway(),
    messages: string[] = [],
    records: Record<string, unknown>[] = [];
  let finish!: () => void,
    acks = 0,
    writes = 0;
  const acknowledgement = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const api: BotApi = {
    search: async () => [],
    submit: async () => {
      writes++;
      return receipt;
    },
  };
  const runtime = wireGateway(
    client as unknown as Client,
    api,
    guild,
    undefined,
    { diagnostics: new OperationalDiagnostics('bot', (r) => records.push(r)) },
  );
  client.emit(
    Events.InteractionCreate,
    command(async (message) => {
      messages.push(message);
      acks++;
      await acknowledgement;
    }),
  );
  await flush();
  assert.equal(acks, 1);
  const stop = runtime.stop();
  assert.equal(stop, runtime.stop());
  assert.equal(runtime.ready(), false);
  assert.equal(client.destroyed, 0);
  client.emit(
    Events.InteractionCreate,
    command(async () => {}),
  );
  await flush();
  assert.equal(writes, 1);
  finish();
  assert.equal(await stop, true);
  assert.equal(client.destroyed, 1);
  assert.match(messages[0]!, new RegExp(receipt.submissionId, 'u'));
  assert.ok(
    records.some(
      (r) => r.code === 'RECEIPT_KNOWN' && r.receipt === receipt.submissionId,
    ),
  );
  assert.doesNotMatch(JSON.stringify(records), /imgur|private/iu);
});
test('forced interaction deadline records pending identity without claiming rollback or sending a false receipt', async () => {
  const client = new Gateway(),
    records: Record<string, unknown>[] = [],
    messages: string[] = [];
  const runtime = wireGateway(
    client as unknown as Client,
    { search: async () => [], submit: () => new Promise(() => {}) },
    guild,
    undefined,
    {
      deadlineMs: 15,
      diagnostics: new OperationalDiagnostics('bot', (r) => records.push(r)),
    },
  );
  client.emit(
    Events.InteractionCreate,
    command(async (message) => {
      messages.push(message);
    }),
  );
  await flush();
  assert.equal(await runtime.stop(), false);
  assert.equal(client.destroyed, 1);
  assert.deepEqual(messages, []);
  assert.deepEqual(records.find((r) => r.code === 'DRAIN_EXPIRED')!.pending, [
    id,
  ]);
});
test('known receipt acknowledgement failures retain the receipt, and unexpected handlers are sanitized and release work', async () => {
  const client = new Gateway(),
    records: Record<string, unknown>[] = [],
    messages: string[] = [];
  const runtime = wireGateway(
    client as unknown as Client,
    { search: async () => [], submit: async () => receipt },
    guild,
    undefined,
    { diagnostics: new OperationalDiagnostics('bot', (r) => records.push(r)) },
  );
  client.emit(
    Events.InteractionCreate,
    command(async (message) => {
      messages.push(message);
      throw Error('unsafe proof password cookie');
    }),
  );
  await flush();
  assert.equal(messages.length, 2);
  assert.equal(messages[0], messages[1]);
  assert.match(messages[1]!, /Saved for admin review/u);
  client.emit(
    Events.InteractionCreate,
    command(
      async () => {},
      async () => {
        throw Object.assign(Error('unsafe token'), { code: 'unsafe' });
      },
    ),
  );
  await flush();
  assert.ok(
    records.some(
      (r) =>
        r.operation === 'gateway' &&
        r.category === 'unexpected' &&
        r.correlation === id,
    ),
  );
  assert.equal(await runtime.stop(), true);
  assert.doesNotMatch(
    JSON.stringify(records),
    /unsafe|password|cookie|proof/iu,
  );
});
