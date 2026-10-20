/** Check the serialized Discord contract without logging in or registering commands. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectionLogCommand } from './command.js';
import { ApplicationCommandOptionType } from 'discord.js';

test('submission command keeps required item/screenshot before optional name and uses autocomplete', () => {
  const command = collectionLogCommand.toJSON();
  assert.equal(command.name, 'cc-clog');
  assert.equal(
    command.options?.length,
    1,
    'DEC-01 allows only /cc-clog submit',
  );
  const submit = command.options?.[0];
  assert.equal(submit?.name, 'submit');
  assert.ok(submit && 'options' in submit);
  assert.deepEqual(
    submit.options?.map((option) => option.name),
    ['item', 'screenshot', 'submitter-name', 'hardcore'],
  );
  const item = submit.options?.[0];
  assert.ok(item && 'autocomplete' in item && item.autocomplete);
  assert.equal(submit.options?.[1]?.required, true);
  assert.equal(
    submit.options?.[1]?.type,
    ApplicationCommandOptionType.Attachment,
  );
  assert.equal(submit.options?.[2]?.required, false);
  assert.equal(submit.options?.[3]?.required, false);
});
