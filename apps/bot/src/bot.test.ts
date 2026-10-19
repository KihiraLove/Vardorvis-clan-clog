const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
  'base64',
);
const screenshot = {
  id: '456789012345678901',
  name: 'proof.png',
  size: png.length,
  contentType: 'image/png',
  url: 'https://cdn.discordapp.com/attachments/234567890123456789/456789012345678901/proof.png?ex=test&hm=signed',
};
class TestBotApi extends HttpBotApi {
  constructor(
    origin: string,
    token: string,
    request: typeof fetch = fetch,
    searchTimeoutMs?: number,
    submitTimeoutMs?: number,
  ) {
    super(
      origin,
      token,
      request,
      searchTimeoutMs,
      submitTimeoutMs,
      async () => png,
    );
  }
}
async function bodyClaim(options: RequestInit | undefined) {
  const form = await new Request('https://api.example/api/v1/bot/submissions', {
    method: 'POST',
    headers: options!.headers!,
    body: options!.body!,
  }).formData();
  assert.deepEqual(
    Buffer.from(await (form.get('screenshot') as File).arrayBuffer()),
    png,
  );
  return String(form.get('submission'));
}

/** Discord interaction and API tests need no live gateway credentials. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { closedCollectionPageMessage } from '@clog/domain';
import { Events, MessageFlags, type Client } from 'discord.js';
import {
  HttpBotApi,
  BotApiError,
  UnconfirmedSubmissionError,
  type BotApi,
  type Candidate,
  type Claim,
  type Receipt,
} from './api.js';
import { readBotConfig } from './config.js';
import {
  collectorSnapshot,
  failureMessage,
  handleAutocomplete,
  handleSubmission,
  receiptMessage,
} from './handler.js';
import { registerFromEnv, registerGuildCommand } from './register.js';
import { wireGateway } from './runtime.js';

const guildId = '234567890123456789';
const userId = '123456789012345678';
const token = 'a'.repeat(64);
const receipt: Receipt = {
  submissionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  interactionId: '345678901234567890',
  status: 'pending',
  submittedAt: '2026-10-08T12:00:00.000Z',
  collectedOn: '2026-10-08',
  dateSource: 'submission_default',
  hardcore: false,
  resolution: 'resolved',
  itemId: 42,
  candidates: [{ id: 42, name: 'Dragon axe' }],
  creditOccupied: false,
};
test('Discord receipts show collection type and validate new types without requiring them on legacy replies', async () => {
  assert.match(
    receiptMessage({ ...receipt, collectionType: 'event' }),
    /Event collection/u,
  );
  assert.match(
    receiptMessage({ ...receipt, collectionType: 'regular', hardcore: true }),
    /Regular collection/u,
  );
  assert.match(
    receiptMessage({
      ...receipt,
      collectionType: null,
      itemId: null,
      resolution: 'needs_match',
    }),
    /Awaiting item match/u,
  );
  const claim: Claim = {
    interactionId: receipt.interactionId,
    guildId,
    actorDiscordId: userId,
    rawItemText: 'Dragon axe',
    collectorName: 'Collector',

    hardcore: false,
  };
  for (const invalid of ['unknown', 42]) {
    const api = new TestBotApi('https://clog.example', token, async () =>
      Response.json({ ...receipt, collectionType: invalid }, { status: 201 }),
    );
    await assert.rejects(
      api.submit(claim, screenshot),
      UnconfirmedSubmissionError,
    );
  }
});
function fakeCommand(
  options: {
    guild?: string | null;
    member?: object | null;
    item?: string;
    screenshot?: typeof screenshot | null;
    name?: string | null;
    hardcore?: boolean | null;
  } = {},
) {
  const messages: string[] = [];
  const deferOptions: unknown[] = [];
  const command = {
    guildId: options.guild === undefined ? guildId : options.guild,
    id: receipt.interactionId,
    user: { id: userId, username: 'DiscordUsername' },
    member:
      options.member === undefined ? { nick: 'ClanNickname' } : options.member,
    options: {
      getString: (key: string) =>
        ({
          item: options.item ?? 'Dragon axe',
          'submitter-name': options.name ?? null,
        })[key as 'item' | 'submitter-name'] ?? null,
      getAttachment: () =>
        options.screenshot === undefined ? screenshot : options.screenshot,
      getBoolean: (key: string) =>
        key === 'hardcore' ? (options.hardcore ?? null) : null,
    },
    deferReply: async (flags: unknown) => {
      deferOptions.push(flags);
    },
    editReply: async (message: string) => {
      messages.push(message);
    },
  };
  return {
    command: command as unknown as Parameters<typeof handleSubmission>[0],
    messages,
    deferOptions,
  };
}
function mockApi(override?: Partial<BotApi>) {
  const submitted: Claim[] = [];
  const searches: string[] = [];
  const api: BotApi = {
    search: async (query: string): Promise<Candidate[]> => {
      searches.push(query);
      return [{ id: 42, name: 'Dragon axe' }];
    },
    submit: async (claim: Claim) => {
      submitted.push(claim);
      return {
        ...receipt,
        interactionId: claim.interactionId,
        hardcore: claim.hardcore,
      };
    },
    ...override,
  };
  return { api, submitted, searches };
}
test('configuration requires complete private credentials; only Guilds intent is used by runtime', () => {
  assert.equal(readBotConfig({}), null);
  const env = {
    DISCORD_BOT_TOKEN: 'discord-token',
    DISCORD_GUILD_ID: guildId,
    BOT_API_TOKEN: token,
    API_BASE_URL: 'http://api:3000',
  };
  assert.deepEqual(readBotConfig(env), {
    discordToken: env.DISCORD_BOT_TOKEN,
    guildId,
    apiToken: token,
    apiOrigin: 'http://api:3000',
  });
  for (const patch of [
    { DISCORD_BOT_TOKEN: '' },
    { DISCORD_GUILD_ID: '' },
    { BOT_API_TOKEN: 'too-short' },
    { DISCORD_GUILD_ID: '123' },
    { API_BASE_URL: 'https://user:pass@api.example/' },
    { API_BASE_URL: 'file:///etc/passwd' },
    { API_BASE_URL: 'http://api:3000/private' },
  ])
    assert.throws(() => readBotConfig({ ...env, ...patch }));
});
test('collector name prefers explicit, guild nickname/displayName, then username', () => {
  assert.equal(
    collectorSnapshot({ nick: 'Nickname' } as never, 'Username', null),
    'Nickname',
  );
  assert.equal(
    collectorSnapshot({ displayName: 'Display' } as never, 'Username', null),
    'Display',
  );
  assert.equal(
    collectorSnapshot({ nick: ' ' } as never, 'Username', null),
    'Username',
  );
  assert.equal(collectorSnapshot(null, 'Username', null), 'Username');
  assert.equal(collectorSnapshot(null, 'Username', ' Personal '), 'Personal');
});
test('submission defers ephemerally before persistence and forwards selected item, actor and hardcore', async () => {
  const { command, deferOptions, messages } = fakeCommand({
    item: 'item:42',
    hardcore: true,
    member: { nick: 'Guild Member' },
  });
  const { api, submitted } = mockApi();
  await handleSubmission(command, api, guildId);
  assert.deepEqual(deferOptions, [{ flags: MessageFlags.Ephemeral }]);
  assert.deepEqual(submitted, [
    {
      interactionId: receipt.interactionId,
      guildId,
      actorDiscordId: userId,
      rawItemText: 'item:42',
      itemId: 42,
      collectorName: 'Guild Member',

      hardcore: true,
    },
  ]);
  assert.match(messages[0]!, /Saved for admin review/u);
  assert.match(messages[0]!, /No collection credit is awarded/u);
  assert.match(messages[0]!, /Mode: hardcore/u);
});
test('free text and omitted hardcore default false; unmatched and occupied receipts are explicit', async () => {
  const { api, submitted } = mockApi({
    submit: async (claim) => {
      submitted.push(claim);
      return {
        ...receipt,
        resolution: 'needs_match',
        itemId: null,
        candidates: [],
        hardcore: claim.hardcore,
        creditOccupied: false,
      };
    },
  });
  const input = fakeCommand({ item: 'Unmatched axe', member: null });
  await handleSubmission(input.command, api, guildId);
  assert.equal(submitted[0]?.itemId, undefined);
  assert.equal(submitted[0]?.hardcore, false);
  assert.equal(submitted[0]?.collectorName, 'DiscordUsername');
  assert.match(input.messages[0]!, /needs manual matching/u);
  const warning = receiptMessage({
    ...receipt,
    creditOccupied: true,
    hardcore: true,
  });
  assert.match(warning, /already exists/u);
  assert.match(warning, /will not add another credit/u);
  assert.doesNotMatch(warning, /approved your claim/u);
});
test('invalid proof, unconfigured guild and invalid IDs never call intake API', async () => {
  for (const input of [
    fakeCommand({
      screenshot: { ...screenshot, url: 'https://imgur.com.attacker.com/1' },
    }),
    fakeCommand({ guild: null }),
    fakeCommand({ guild: '999999999999999999' }),
    fakeCommand({ item: 'item:9999999999999999999999' }),
  ]) {
    const { api, submitted } = mockApi();
    await handleSubmission(input.command, api, guildId);
    assert.equal(submitted.length, 0);
    assert.equal(input.deferOptions.length, 1);
    assert.ok(input.messages[0]);
  }
});
test('an old registered command without the screenshot option explains registration and never implies a saved claim', async () => {
  const input = fakeCommand({ screenshot: null });
  const { api, submitted } = mockApi();
  await handleSubmission(input.command, api, guildId);
  assert.equal(submitted.length, 0);
  assert.match(input.messages[0]!, /register \/cc-clog again/u);
  assert.match(input.messages[0]!, /Nothing was sent/u);
  assert.doesNotMatch(
    input.messages[0]!,
    /might have reached|Saved for admin review/u,
  );
});
test('failed/unconfirmed API submissions are never acknowledged as saved', async () => {
  for (const error of [
    new BotApiError(409),
    new BotApiError(422),
    new BotApiError(503),
    new Error('timeout'),
  ]) {
    const input = fakeCommand();
    await handleSubmission(
      input.command,
      mockApi({
        submit: async () => {
          throw error;
        },
      }).api,
      guildId,
    );
    assert.doesNotMatch(input.messages[0]!, /Saved for admin review/u);
    assert.match(
      input.messages[0]!,
      /Nothing new was saved|Nothing was saved|could not be confirmed/u,
    );
  }
  assert.match(failureMessage(new BotApiError(429)), /rate-limited/u);
});
test('autocomplete searches on every focus (no stale cache), including canonical manual items', async () => {
  const responses: object[][] = [];
  const { api, searches } = mockApi({
    search: async (q: string) => {
      searches.push(q);
      return [{ id: 999, name: 'Manual item (no game ID)' }];
    },
  });
  const fake = {
    guildId,
    commandName: 'cc-clog',
    options: {
      getSubcommand: () => 'submit',
      getFocused: (full?: boolean) =>
        full ? { name: 'item', value: 'manual' } : 'manual',
    },
    responded: false,
    respond: async (data: object[]) => {
      responses.push(data);
    },
  } as unknown as Parameters<typeof handleAutocomplete>[0];
  await handleAutocomplete(fake, api, guildId);
  await handleAutocomplete(fake, api, guildId);
  assert.deepEqual(searches, ['manual', 'manual']);
  assert.deepEqual(responses[0], [
    { name: 'Manual item (no game ID)', value: 'item:999' },
  ]);
  const other = {
    ...fake,
    guildId: '999999999999999999',
    respond: async (data: object[]) => {
      responses.push(data);
    },
  };
  await handleAutocomplete(
    other as unknown as Parameters<typeof handleAutocomplete>[0],
    api,
    guildId,
  );
  assert.deepEqual(responses[2], []);
  assert.equal(searches.length, 2);
});
test('HTTP adapter only fetches fixed bot routes, retries timeout using identical payload and trusts 200 receipt', async () => {
  const urls: string[] = [];
  const bodies: string[] = [];
  let submitCalls = 0;
  const request = (async (input: URL, options: RequestInit) => {
    urls.push(input.toString());
    assert.equal(options.redirect, 'error');
    assert.equal(
      (options.headers as Record<string, string>).Authorization,
      'Bearer ' + token,
    );
    if (input.pathname.endsWith('/items'))
      return Response.json({ items: [{ id: 42, name: 'Dragon axe' }] });
    submitCalls++;
    bodies.push(await bodyClaim(options));
    if (submitCalls === 1) throw new Error('socket disconnected after commit');
    return Response.json(receipt, { status: 200 });
  }) as typeof fetch;
  const api = new TestBotApi('http://api:3000', token, request);
  assert.deepEqual(await api.search('dragon axe'), [
    { id: 42, name: 'Dragon axe' },
  ]);
  const claim: Claim = {
    interactionId: receipt.interactionId,
    guildId,
    actorDiscordId: userId,
    rawItemText: 'Dragon axe',
    collectorName: 'User',

    hardcore: false,
  };
  assert.deepEqual(await api.submit(claim, screenshot), receipt);
  assert.equal(submitCalls, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(
    urls[0],
    'http://api:3000/api/v1/bot/items?q=dragon+axe&limit=25',
  );
  assert.equal(urls[1], 'http://api:3000/api/v1/bot/submissions');
});
test('closed-page rejections explain scheduling without retrying or exposing arbitrary API messages', async () => {
  const claim: Claim = {
    interactionId: receipt.interactionId,
    guildId,
    actorDiscordId: userId,
    rawItemText: 'Dragon axe',
    collectorName: 'User',

    hardcore: false,
  };
  let calls = 0;
  const api = new TestBotApi('http://api:3000', token, async () => {
    calls++;
    return Response.json(
      { error: closedCollectionPageMessage },
      { status: 403 },
    );
  });
  await assert.rejects(
    api.submit(claim, screenshot),
    (error: unknown) =>
      error instanceof BotApiError &&
      error.status === 403 &&
      failureMessage(error) === closedCollectionPageMessage,
  );
  assert.equal(calls, 1);
  assert.ok(
    !failureMessage(new BotApiError(403, 'private service details')).includes(
      'private service details',
    ),
  );
});
test('HTTP conflicts and malformed API responses fail rather than inventing a receipt', async () => {
  const claim: Claim = {
    interactionId: receipt.interactionId,
    guildId,
    actorDiscordId: userId,
    rawItemText: 'Dragon axe',
    collectorName: 'User',

    hardcore: false,
  };
  let calls = 0;
  const conflict = new TestBotApi('http://api:3000', token, (async () => {
    calls++;
    return Response.json({ error: 'conflict' }, { status: 409 });
  }) as typeof fetch);
  await assert.rejects(conflict.submit(claim, screenshot), { status: 409 });
  assert.equal(calls, 1);
  const corrupt = new TestBotApi('http://api:3000', token, (async () =>
    Response.json({ status: 'approved' }, { status: 201 })) as typeof fetch);
  await assert.rejects(corrupt.submit(claim, screenshot), (error: unknown) => {
    assert.ok(error instanceof UnconfirmedSubmissionError);
    assert.equal(error.reason, 'invalid-receipt');
    assert.equal(error.interactionId, claim.interactionId);
    assert.doesNotMatch(failureMessage(error), /Saved for admin review/u);
    return true;
  });
  const badSearch = new TestBotApi('http://api:3000', token, (async () =>
    Response.json({ items: [{ id: 'bad', name: 'x' }] })) as typeof fetch);
  await assert.rejects(badSearch.search('x'), { status: 502 });
});
test('explicit guild registration uses POST upsert, not bulk PUT, and never happens at startup', async () => {
  const writes: { route: string; body: object }[] = [];
  const post = async (route: string, body: object) => {
    writes.push({ route, body });
  };
  await registerGuildCommand(userId, guildId, post);
  assert.equal(writes.length, 1);
  assert.equal(
    writes[0]?.route,
    '/applications/' + userId + '/guilds/' + guildId + '/commands',
  );
  await assert.rejects(
    registerFromEnv(
      'test',
      {
        DISCORD_APPLICATION_ID: userId,
        DISCORD_BOT_TOKEN: 'test',
      },
      post,
    ),
  );
  await registerFromEnv(
    'test',
    {
      DISCORD_APPLICATION_ID: userId,
      DISCORD_BOT_TOKEN: 'test',
      DISCORD_TEST_GUILD_ID: guildId,
    },
    post,
  );
  assert.equal(writes.length, 2);
  assert.equal((writes[1]?.body as { name: string }).name, 'cc-clog');
});
test('gateway handlers survive reconnect; stop prevents new interactions and destroys client once', async () => {
  class FakeGateway extends EventEmitter {
    online = false;
    destroyed = 0;
    isReady() {
      return this.online;
    }
    destroy() {
      this.destroyed++;
    }
  }
  const fake = new FakeGateway();
  const gateway = wireGateway(
    fake as unknown as Client,
    mockApi().api,
    guildId,
  );
  assert.equal(gateway.ready(), false);
  fake.online = true;
  assert.equal(gateway.ready(), true);
  fake.online = false;
  assert.equal(gateway.ready(), false);
  fake.online = true;
  assert.equal(gateway.ready(), true);
  assert.equal(fake.listenerCount(Events.InteractionCreate), 1);
  await gateway.stop();
  await gateway.stop();
  assert.equal(gateway.ready(), false);
  assert.equal(fake.destroyed, 1);
  assert.equal(fake.listenerCount(Events.InteractionCreate), 1);
});

test('bot readiness probes authenticated intake and rejects unavailable or malformed responses', async () => {
  const routes: string[] = [];
  const healthy = new TestBotApi('http://api:3000', token, (async (
    url: URL,
    init: RequestInit,
  ) => {
    routes.push(url.toString());
    assert.equal(
      (init.headers as Record<string, string>).Authorization,
      'Bearer ' + token,
    );
    return Response.json({ items: [{ id: 42, name: 'Dragon axe' }] });
  }) as typeof fetch);
  assert.equal(await healthy.checkReady(), true);
  assert.equal(routes[0], 'http://api:3000/api/v1/bot/items?q=&limit=1');
  const unavailable = new TestBotApi('http://api:3000', token, (async () =>
    Response.json({ error: 'disabled' }, { status: 503 })) as typeof fetch);
  assert.equal(await unavailable.checkReady(), false);
  const malformed = new TestBotApi('http://api:3000', token, (async () =>
    Response.json({
      items: [{ id: 'not-an-id', name: 'Bad' }],
    })) as typeof fetch);
  assert.equal(await malformed.checkReady(), false);
  const refused = new TestBotApi('http://api:3000', token, (async () => {
    throw Error('Connection refused');
  }) as typeof fetch);
  assert.equal(await refused.checkReady(), false);
});
