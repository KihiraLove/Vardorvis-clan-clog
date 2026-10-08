/** Describe Discord's command payload; this module does not contact Discord. */
import { SlashCommandBuilder } from 'discord.js';

/** Contract only: registration and persistence will be delivered in the bot workstream. */
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
      .addStringOption((option) =>
        option
          .setName('proof')
          .setDescription('HTTPS Imgur or Gyazo proof link')
          .setRequired(true)
          .setMaxLength(2048),
      )
      .addStringOption((option) =>
        option
          .setName('submitter-name')
          .setDescription(
            'Collector name; defaults to your Discord display name',
          )
          .setMaxLength(80),
      ),
  );
