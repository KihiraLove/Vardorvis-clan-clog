import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  downloadScreenshot,
  validateScreenshot,
  maxScreenshotBytes,
  ScreenshotError,
} from './screenshot.js';
import { HttpBotApi } from './api.js';
import { failureMessage } from './handler.js';
import { collectionLogCommand } from './command.js';

const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
  'base64',
);
const attachment = {
  id: '456789012345678901',
  name: 'proof.png',
  size: bytes.length,
  contentType: 'image/png',
  url: 'https://cdn.discordapp.com/attachments/234567890123456789/456789012345678901/proof.png?ex=secret&hm=signed',
};
test('the registered command requires a screenshot attachment and has no proof URL option', () => {
  const submit = collectionLogCommand.toJSON().options![0]!;
  assert.equal(submit.type, 1);
  if (submit.type !== 1) throw Error('Subcommand');
  const option = submit.options!.find((value) => value.name === 'screenshot')!;
  assert.equal(option.type, 11);
  assert.equal(option.required, true);
  assert.equal(
    submit.options!.some((value) => value.name === 'proof'),
    false,
  );
});
test('attachment metadata permits only bounded PNGs from the matching Discord attachment endpoint', () => {
  for (const host of ['cdn.discordapp.com', 'media.discordapp.net'])
    assert.equal(
      validateScreenshot({
        ...attachment,
        url: attachment.url.replace('cdn.discordapp.com', host),
      }).hostname,
      host,
    );
  for (const patch of [
    { size: 0 },
    { size: maxScreenshotBytes + 1 },
    { size: NaN },
    { name: 'proof.webp' },
    { contentType: 'image/jpeg' },
    {
      url: 'http://cdn.discordapp.com/attachments/234567890123456789/456789012345678901/proof.png',
    },
    {
      url: 'https://cdn.discordapp.com.attacker.test/attachments/234567890123456789/456789012345678901/proof.png',
    },
    {
      url: 'https://user:secret@cdn.discordapp.com/attachments/234567890123456789/456789012345678901/proof.png',
    },
    {
      url: 'https://cdn.discordapp.com:8443/attachments/234567890123456789/456789012345678901/proof.png',
    },
    {
      url: attachment.url.replace(
        '/456789012345678901/',
        '/456789012345678902/',
      ),
    },
    { url: 'https://cdn.discordapp.com/icons/456789012345678901/proof.png' },
    { url: 'https://127.0.0.1/private' },
    { url: 'file:///private/proof.png' },
  ])
    assert.throws(
      () => validateScreenshot({ ...attachment, ...patch }),
      ScreenshotError,
    );
});
test('PNG download omits credentials, rejects redirects and reads only bounded attachment bytes', async () => {
  let calls = 0;
  const png = await downloadScreenshot(attachment, async (url, options) => {
    calls++;
    assert.equal(String(url), attachment.url);
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.credentials, 'omit');
    assert.deepEqual(options?.headers, { Accept: 'image/png' });
    assert.ok(options?.signal);
    return new Response(bytes, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(bytes.length),
      },
    });
  });
  assert.equal(calls, 1);
  assert.deepEqual(Buffer.from(png), bytes);
});
test('download failures, MIME/length mismatches and corrupt signatures never become an uncertain API receipt', async () => {
  for (const response of [
    () =>
      new Response('redirect', {
        status: 302,
        headers: { Location: 'https://attacker.test' },
      }),
    () => new Response('private error', { status: 503 }),
    () => new Response(bytes, { headers: { 'Content-Type': 'image/jpeg' } }),
    () =>
      new Response(bytes, {
        headers: { 'Content-Length': String(bytes.length + 1) },
      }),
    () => new Response(Buffer.alloc(bytes.length)),
    () => new Response(bytes.subarray(0, 20)),
  ])
    await assert.rejects(
      downloadScreenshot(attachment, async () => response()),
      (error) => {
        assert.ok(error instanceof ScreenshotError);
        assert.match(failureMessage(error), /Nothing was sent/u);
        assert.doesNotMatch(
          failureMessage(error),
          /signed|secret|private error|attacker/u,
        );
        return true;
      },
    );
});
test('oversized streaming attachments are cancelled before the rest of the body is read', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(attachment.size + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    downloadScreenshot(attachment, async () => new Response(stream)),
    ScreenshotError,
  );
  assert.equal(cancelled, true);
});
test('the download deadline aborts before any API submission can be attempted', async () => {
  await assert.rejects(
    downloadScreenshot(
      attachment,
      async (_url, options) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        options!.signal!.throwIfAborted();
        return new Response(bytes);
      },
      5,
    ),
    ScreenshotError,
  );
});
test('multipart retries download once and preserve identical metadata, PNG bytes and boundary without a CDN URL', async () => {
  const claim = {
    interactionId: '345678901234567890',
    guildId: '234567890123456789',
    actorDiscordId: '123456789012345678',
    rawItemText: 'New item',
    collectorName: 'Collector',
    hardcore: false,
  };
  const receipt = {
    submissionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    interactionId: claim.interactionId,
    status: 'pending',
    submittedAt: '2026-10-19T10:00:00Z',
    collectedOn: '2026-10-19',
    dateSource: 'submission_default',
    hardcore: false,
    resolution: 'needs_match',
    itemId: null,
    candidates: [],
    creditOccupied: false,
  };
  let downloads = 0;
  const requests: Buffer[] = [];
  const api = new HttpBotApi(
    'https://api.example',
    'a'.repeat(64),
    async (url, options) => {
      const raw = Buffer.from(options!.body as ArrayBuffer);
      requests.push(raw);
      const form = await new Request(url, {
        method: 'POST',
        headers: options!.headers!,
        body: raw,
      }).formData();
      assert.deepEqual(JSON.parse(String(form.get('submission'))), claim);
      assert.deepEqual(
        Buffer.from(await (form.get('screenshot') as File).arrayBuffer()),
        bytes,
      );
      assert.equal(raw.includes(Buffer.from('cdn.discordapp')), false);
      if (requests.length === 1) throw new Error('Lost response after commit');
      return Response.json(receipt, { status: 200 });
    },
    undefined,
    undefined,
    async () => {
      downloads++;
      return bytes;
    },
  );
  assert.deepEqual(await api.submit(claim, attachment), receipt);
  assert.equal(downloads, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
});
