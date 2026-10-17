import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkloadError } from '@clog/domain';
import { HttpBotApi, type BotApi, type Receipt } from './api.js';
import { handleSubmission, handleAutocomplete } from './handler.js';
import {
  BotWorkloads,
  readWorkloadLimits,
  searchRetryChoice,
} from './workloads.js';
const guild = '234567890123456789',
  user = '123456789012345678',
  interactionId = '345678901234567890';
function command(item = 'item:42') {
  const messages: string[] = [];
  return {
    messages,
    interaction: {
      guildId: guild,
      id: interactionId,
      user: { id: user, username: 'Fixture' },
      member: null,
      options: {
        getString: (key: string) =>
          key === 'item'
            ? item
            : key === 'proof'
              ? 'https://imgur.com/a/fixture'
              : null,
        getBoolean: () => false,
      },
      deferReply: async () => undefined,
      editReply: async (text: string) => {
        messages.push(text);
      },
    } as unknown as Parameters<typeof handleSubmission>[0],
  };
}
const receipt: Receipt = {
  submissionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  interactionId,
  status: 'pending',
  submittedAt: '2026-10-14T00:00:00.000Z',
  collectedOn: '2026-10-14',
  dateSource: 'submission_default',
  hardcore: false,
  resolution: 'resolved',
  itemId: 42,
  candidates: [],
  creditOccupied: false,
};
test('Discord user/guild quotas are independent, bounded and configurable with expiry and retry', () => {
  let now = 0;
  const workloads = new BotWorkloads(
    { intakeUser: 2, intakeGuild: 3, searchUser: 4, searchGuild: 6 },
    () => now,
    10,
  );
  workloads.intake.acquire(['g1', 'g1:u1'])();
  workloads.intake.acquire(['g1', 'g1:u1'])();
  assert.throws(() => workloads.intake.acquire(['g1', 'g1:u1']), {
    retryAfterSeconds: 60,
  });
  workloads.intake.acquire(['g1', 'g1:u2'])();
  assert.throws(() => workloads.intake.acquire(['g1', 'g1:u3']), WorkloadError);
  assert.throws(() => workloads.intake.acquire(['g1', 'g1:u2']), {
    retryAfterSeconds: 60,
  });
  workloads.intake.acquire(['g2', 'g2:u1'])();
  assert.deepEqual(workloads.intake.snapshot().keys, [2, 3]);
  now = 60000;
  workloads.intake.acquire(['g2', 'g2:u1'])();
  workloads.intake.acquire(['g1', 'g1:u1'])();
  assert.deepEqual(workloads.intake.snapshot().keys, [2, 2]);
  workloads.close();
  assert.throws(() => workloads.intake.acquire(['g1', 'g1:u1']), WorkloadError);
  assert.deepEqual(readWorkloadLimits({ BOT_INTAKE_USER_PER_MINUTE: '3' }), {
    intakeUser: 3,
    intakeGuild: 60,
    searchUser: 30,
    searchGuild: 300,
  });
  for (const text of ['0', '-1', '1.5', '121', 'no'])
    assert.throws(() =>
      readWorkloadLimits({ BOT_INTAKE_GUILD_PER_MINUTE: text }),
    );
});
test('Discord admission never splits identical HTTP retries or turns an uncertain committed receipt into a rejection', async () => {
  let now = 0,
    calls = 0;
  const bodies: string[] = [];
  const api = new HttpBotApi('http://api:3000', 'a'.repeat(64), (async (
    _url,
    init,
  ) => {
    calls++;
    bodies.push(String(init?.body));
    if (calls === 1)
      throw new Error('Receipt acknowledgement lost after commit');
    if (calls === 2) return new Response(null, { status: 429 });
    return Response.json(receipt);
  }) as typeof fetch);
  const workloads = new BotWorkloads(
    { intakeUser: 1, intakeGuild: 5, searchUser: 5, searchGuild: 10 },
    () => now,
  );
  const first = command();
  await handleSubmission(first.interaction, api, guild, workloads);
  assert.equal(calls, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.match(first.messages[0]!, /could not be confirmed/u);
  assert.doesNotMatch(
    first.messages[0]!,
    /Nothing was saved|Saved for admin review/u,
  );
  const denied = command();
  await handleSubmission(denied.interaction, api, guild, workloads);
  assert.equal(calls, 2);
  assert.match(denied.messages[0]!, /Wait 60 seconds/u);
  assert.match(denied.messages[0]!, /This delivery was not sent/u);
  assert.match(denied.messages[0]!, /ask an admin to check its receipt/u);
  assert.doesNotMatch(denied.messages[0]!, /Nothing was saved/u);
  now = 60000;
  const replay = command();
  await handleSubmission(replay.interaction, api, guild, workloads);
  assert.equal(calls, 3);
  assert.equal(bodies[2], bodies[0]);
  assert.match(replay.messages[0]!, /Saved for admin review/u);
  assert.match(replay.messages[0]!, new RegExp(receipt.submissionId, 'u'));
});
test('autocomplete bursts shed queries, show a safe retry hint, recover and cannot submit that hint', async () => {
  let now = 0,
    searches = 0,
    writes = 0;
  const api: BotApi = {
    search: async () => {
      searches++;
      return [{ id: 42, name: 'Item' }];
    },
    submit: async () => {
      writes++;
      return receipt;
    },
  };
  const workloads = new BotWorkloads(
    { intakeUser: 5, intakeGuild: 60, searchUser: 2, searchGuild: 4 },
    () => now,
  );
  const replies: { name: string; value: string }[][] = [];
  const interaction = {
    guildId: guild,
    user: { id: user },
    commandName: 'cc-clog',
    responded: false,
    options: {
      getSubcommand: () => 'submit',
      getFocused: (full?: boolean) => (full ? { name: 'item' } : 'Item'),
    },
    respond: async (choices: { name: string; value: string }[]) => {
      replies.push(choices);
    },
  } as unknown as Parameters<typeof handleAutocomplete>[0];
  for (let n = 0; n < 10; n++)
    await handleAutocomplete(interaction, api, guild, workloads);
  assert.equal(searches, 2);
  assert.match(replies[2]![0]!.name, /wait 60s/u);
  assert.equal(replies[2]![0]!.value, searchRetryChoice);
  const hint = command(searchRetryChoice);
  await handleSubmission(hint.interaction, api, guild, workloads);
  assert.equal(writes, 0);
  assert.match(hint.messages[0]!, /type the item name manually/u);
  now = 60000;
  await handleAutocomplete(interaction, api, guild, workloads);
  assert.equal(searches, 3);
  assert.equal(replies.at(-1)![0]!.value, 'item:42');
});
test('concurrent autocomplete cannot exceed per-user work, and failures release admission', async () => {
  const workloads = new BotWorkloads();
  const writes = Array.from({ length: 4 }, (_, i) =>
    workloads.intake.acquire(['g1', 'g1:' + i]),
  );
  assert.throws(
    () => workloads.intake.acquire(['g1', 'g1:extra']),
    WorkloadError,
  );
  writes.push(
    ...Array.from({ length: 4 }, (_, i) =>
      workloads.intake.acquire(['g2', 'g2:' + i]),
    ),
  );
  assert.throws(
    () => workloads.intake.acquire(['g3', 'g3:extra']),
    WorkloadError,
  );
  for (const release of writes) release();
  const first = workloads.search.acquire([guild, guild + ':' + user]);
  const second = workloads.search.acquire([guild, guild + ':' + user]);
  assert.throws(() => workloads.search.acquire([guild, guild + ':' + user]), {
    retryAfterSeconds: 1,
  });
  const other = workloads.search.acquire([guild, guild + ':other']);
  first();
  second();
  other();
  await assert.rejects(
    workloads.search.run([guild, guild + ':' + user], async () => {
      throw new Error('lookup failed');
    }),
  );
  assert.equal(workloads.search.snapshot().active, 0);
});
