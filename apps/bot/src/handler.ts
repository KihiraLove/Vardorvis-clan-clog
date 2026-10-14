/** Discord is an adapter; only an API 200/201 may produce a saved receipt. */
import {
  validateProofUrl,
  WorkloadError,
  type OperationalDiagnostics,
} from '@clog/domain';
import { type BotWorkloads, searchRetryChoice } from './workloads.js';
import {
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import {
  BotApiError,
  UnconfirmedSubmissionError,
  botFailure,
  type BotApi,
  type Receipt,
} from './api.js';
import { closedCollectionPageMessage } from '@clog/domain';

export function validProof(value: string): boolean {
  try {
    validateProofUrl(value);
    return true;
  } catch {
    return false;
  }
}
export function collectorSnapshot(
  member: ChatInputCommandInteraction['member'],
  username: string,
  explicit: string | null,
): string {
  if (explicit !== null) return explicit.trim();
  if (
    member &&
    'displayName' in member &&
    typeof member.displayName === 'string' &&
    member.displayName.trim()
  )
    return member.displayName.trim();
  if (
    member &&
    'nick' in member &&
    typeof member.nick === 'string' &&
    member.nick.trim()
  )
    return member.nick.trim();
  return username;
}
export function receiptMessage(receipt: Receipt): string {
  const mode = receipt.hardcore ? 'hardcore' : 'normal';
  const state =
    receipt.resolution === 'resolved'
      ? 'Item matched. Saved for admin review.'
      : 'Item needs manual matching. Saved for admin review.';
  const occupied = receipt.creditOccupied
    ? 'An approved ' +
      mode +
      ' credit already exists for this item. This claim will not add another credit.'
    : 'No collection credit is awarded until an admin approves the claim.';
  return (
    state +
    '\n' +
    occupied +
    '\nMode: ' +
    mode +
    '. Receipt: ' +
    receipt.submissionId
  );
}
/** Discord snowflakes are safe operator correlation IDs, not bearer credentials. */
function interactionReference(id: string | undefined): string {
  return id && /^\d{17,20}$/u.test(id)
    ? '\nDiscord interaction ID: ' + id + '.'
    : '';
}

function unconfirmedMessage(interactionId?: string): string {
  return (
    'Submission could not be confirmed. It might have reached the server ' +
    'and been saved for review, but no valid receipt was received.' +
    interactionReference(interactionId) +
    '\nAsk a clan admin to check this interaction ID in the submission history. ' +
    'Do not repeat /cc-clog submit as a new command until checked: Discord ' +
    'assigns a new interaction ID, which can create another submission. ' +
    'No approval or collection credit is implied.'
  );
}

export function failureMessage(error: unknown, interactionId?: string): string {
  if (error instanceof UnconfirmedSubmissionError)
    return unconfirmedMessage(error.interactionId);
  if (error instanceof BotApiError) {
    if (error.status === 403 && error.message === closedCollectionPageMessage)
      return closedCollectionPageMessage;
    if (error.status === 409)
      return 'This Discord interaction ID was already submitted with different details. Nothing new was saved.';
    if (error.status === 422 || error.status === 400)
      return 'The submitted item, date or proof was rejected by the API. Nothing was saved.';
    if (error.status === 403 || error.status === 401)
      return 'The submission service rejected the configured bot credentials or guild. Nothing was saved.';
    if (error.status === 429)
      return 'The submission service is temporarily rate-limited. No receipt could be confirmed; retry later.';
  }
  return unconfirmedMessage(interactionId);
}
export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  api: BotApi,
  guildId: string,
  workloads?: BotWorkloads,
  diagnostics?: OperationalDiagnostics,
): Promise<void> {
  if (
    interaction.guildId !== guildId ||
    interaction.commandName !== 'cc-clog' ||
    interaction.options.getSubcommand(false) !== 'submit' ||
    interaction.options.getFocused(true).name !== 'item'
  ) {
    await interaction.respond([]);
    return;
  }
  let release: (() => void) | undefined;
  try {
    release = workloads?.search.acquire([
      guildId,
      guildId + ':' + interaction.user.id,
    ]);
    const search = interaction.options.getFocused();
    const items = await api.search(String(search).slice(0, 200));
    await interaction.respond(
      items.slice(0, 25).map((item) => ({
        name: item.name.slice(0, 100),
        value: 'item:' + item.id,
      })),
    );
  } catch (error) {
    diagnostics?.record('failure', {
      operation: 'autocomplete',
      ...botFailure(error),
      correlation: interaction.id,
    });
    // Search failure cannot imply a successful match; free-text remains available.
    if (!interaction.responded)
      await interaction
        .respond(
          error instanceof WorkloadError
            ? [
                {
                  name: `Search busy: wait ${error.retryAfterSeconds}s or type an item name`,
                  value: searchRetryChoice,
                },
              ]
            : [],
        )
        .catch(() =>
          diagnostics?.record('failure', {
            operation: 'autocomplete',
            category: 'acknowledgement',
            code: 'ACK_FAILED',
            correlation: interaction.id,
          }),
        );
  } finally {
    release?.();
  }
}
export async function handleSubmission(
  interaction: ChatInputCommandInteraction,
  api: BotApi,
  guildId: string,
  workloads?: BotWorkloads,
  diagnostics?: OperationalDiagnostics,
): Promise<void> {
  // Defer before doing any network I/O, including catalog lookups.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (interaction.guildId !== guildId) {
    await interaction.editReply(
      'This command can only be used in the configured clan server.',
    );
    return;
  }
  let release: (() => void) | undefined;
  let saved: Receipt | undefined;
  try {
    release = workloads?.intake.acquire([
      guildId,
      guildId + ':' + interaction.user.id,
    ]);
    const rawItemText = interaction.options.getString('item', true);
    if (rawItemText === searchRetryChoice) {
      await interaction.editReply(
        'Item search was busy. Wait a few seconds, then search again or type the item name manually. This delivery was not sent to the submission service.',
      );
      return;
    }
    const proofUrl = interaction.options.getString('proof', true);
    const collectorName = collectorSnapshot(
      interaction.member,
      interaction.user.username,
      interaction.options.getString('submitter-name'),
    );
    const hardcore = interaction.options.getBoolean('hardcore') ?? false;
    if (
      !rawItemText.trim() ||
      rawItemText.length > 200 ||
      !collectorName ||
      collectorName.length > 80 ||
      !validProof(proofUrl)
    ) {
      await interaction.editReply(
        'Invalid item, collector name or proof. Use a nonblank item and an HTTPS Imgur/Gyazo link.',
      );
      return;
    }
    const choice = /^item:([1-9]\d*)$/u.exec(rawItemText.trim());
    const itemId = choice ? Number(choice[1]) : undefined;
    if (
      itemId !== undefined &&
      (!Number.isSafeInteger(itemId) || itemId > 2147483647)
    ) {
      await interaction.editReply(
        'The selected catalog item is invalid. Please choose an autocomplete item again.',
      );
      return;
    }
    const receipt = await api.submit({
      interactionId: interaction.id,
      guildId,
      actorDiscordId: interaction.user.id,
      rawItemText,
      ...(itemId === undefined ? {} : { itemId }),
      collectorName,
      proofUrl,
      hardcore,
    });
    saved = receipt;
    diagnostics?.record('receipt', {
      operation: 'submission',
      code: 'RECEIPT_KNOWN',
      correlation: interaction.id,
      receipt: receipt.submissionId,
    });
    await interaction.editReply(receiptMessage(receipt));
  } catch (error) {
    diagnostics?.record(
      'failure',
      saved
        ? {
            operation: 'submission',
            category: 'acknowledgement',
            code: 'ACK_FAILED',
            correlation: interaction.id,
            receipt: saved.submissionId,
          }
        : {
            operation: 'submission',
            ...(error instanceof WorkloadError
              ? { category: 'overload' as const, code: 'OVERLOADED' as const }
              : botFailure(error)),
            correlation: interaction.id,
          },
    );
    await interaction
      .editReply(
        saved
          ? receiptMessage(saved)
          : error instanceof WorkloadError
            ? `Submission busy. Wait ${error.retryAfterSeconds} seconds and try again. This delivery was not sent to the submission service.` +
              interactionReference(interaction.id) +
              '\nIf this interaction was attempted earlier or had an unconfirmed reply, ask an admin to check its receipt before starting a new command.'
            : failureMessage(error, interaction.id),
      )
      .catch(() =>
        diagnostics?.record('failure', {
          operation: 'submission',
          category: 'acknowledgement',
          code: 'ACK_FAILED',
          correlation: interaction.id,
          receipt: saved?.submissionId,
        }),
      );
  } finally {
    release?.();
  }
}
export async function handleInteraction(
  interaction: Interaction,
  api: BotApi,
  guildId: string,
  workloads?: BotWorkloads,
  diagnostics?: OperationalDiagnostics,
): Promise<void> {
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction, api, guildId, workloads, diagnostics);
  } else if (
    interaction.isChatInputCommand() &&
    interaction.commandName === 'cc-clog' &&
    interaction.options.getSubcommand(false) === 'submit'
  ) {
    await handleSubmission(interaction, api, guildId, workloads, diagnostics);
  }
}
