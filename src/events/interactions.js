const { Events, MessageFlags } = require('discord.js');
const { commands, executeButton } = require('../commands');
const { UserError } = require('../errors');

function attachInteractions(client, music) {
  const commandMap = new Map(commands.map((command) => [command.data.name, command]));

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton() && (
        interaction.customId.startsWith('player:') || interaction.customId.startsWith('queue:')
      )) {
        await executeButton(interaction, music);
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      const command = commandMap.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction, music);
    } catch (error) {
      const message = error instanceof UserError || error?.userError
        ? error.message
        : 'Something went wrong running that command.';
      if (!(error instanceof UserError) && !error?.userError) console.error(error);
      if (interaction.isButton()) {
        await sendButtonError(interaction, message);
        return;
      }
      await sendInteractionError(interaction, message);
    }
  });
}

async function sendButtonError(interaction, message) {
  const payload = { content: message, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch (error) {
    console.error(`Could not send a button error: ${error.message}`);
  }
}

async function sendInteractionError(interaction, message) {
  const payload = { content: message, allowedMentions: { parse: [] } };
  if (!interaction.deferred && !interaction.replied) payload.flags = MessageFlags.Ephemeral;
  try {
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply(payload);
  } catch (error) {
    console.error(`Could not send an error reply: ${error.message}`);
  }
}

module.exports = { attachInteractions };
