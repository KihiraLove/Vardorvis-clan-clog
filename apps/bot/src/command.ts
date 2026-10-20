/** Guild slash-command contract; registration is always an explicit operation. */
import { SlashCommandBuilder } from 'discord.js';

export const collectionLogCommand = new SlashCommandBuilder()
  .setName('cc-clog')
  .setDescription('Clan collection log')
  .addSubcommand((command) =>
    command
      .setName('submit')
      .setDescription('Submit proof of a collected item for admin review')
      .addStringOption((option) =>
        option
          .setName('item')
          .setDescription('Choose an item or type its name for manual matching')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(200),
      )
      .addAttachmentOption((option) =>
        option
          .setName('screenshot')
          .setDescription('PNG screenshot proof (up to 10 MiB)')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('submitter-name')
          .setDescription(
            'Collector name; defaults to your Discord display name',
          )
          .setMaxLength(80),
      )
      .addBooleanOption((option) =>
        option
          .setName('hardcore')
          .setDescription(
            'Claim the item was obtained on hardcore worlds (default: no)',
          ),
      ),
  );
