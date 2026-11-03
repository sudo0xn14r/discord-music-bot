const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, Events, GatewayIntentBits, REST, Routes } = require('discord.js');
const { UserError } = require('./errors');
const { commands } = require('./commands');
const { Player } = require('./player');

const token = readEnv('DISCORD_TOKEN');
const guildId = readEnv('GUILD_ID');

if (!token) {
  console.error('DISCORD_TOKEN is missing. Copy .env.example to .env and set your bot token.');
  process.exit(1);
}

if (guildId && !/^\d{17,20}$/.test(guildId)) {
  console.error('GUILD_ID must be a Discord server id (a 17 to 20 digit number), or left empty.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
  allowedMentions: { parse: [] },
});

const player = new Player(client);
const commandMap = new Map(commands.map((command) => [command.data.name, command]));
let shuttingDown = false;

client.once(Events.ClientReady || 'ready', async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}.`);
  try {
    await registerCommands(readyClient.application.id);
  } catch (error) {
    console.error(`Slash command registration failed: ${error.message}`);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commandMap.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, player);
  } catch (error) {
    const message = error instanceof UserError
      ? error.message
      : 'Something went wrong running that command.';
    if (!(error instanceof UserError)) console.error(error);
    await sendInteractionError(interaction, message);
  }
});

client.on('error', (error) => {
  console.error(`Discord client error: ${error.message}`);
});

process.on('unhandledRejection', (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`Unhandled rejection: ${message}`);
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(token).catch((error) => {
  console.error(`Login failed: ${error.message}`);
  process.exit(1);
});

function readEnv(name) {
  let value = (process.env[name] || '').trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

async function registerCommands(applicationId) {
  const rest = new REST({ version: '10' }).setToken(token);
  const body = commands.map((command) => command.data.toJSON());
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body });
    console.log(`Registered ${body.length} slash commands in guild ${guildId}.`);
    return;
  }
  await rest.put(Routes.applicationCommands(applicationId), { body });
  console.log(`Registered ${body.length} global slash commands. They can take up to an hour to appear.`);
}

async function sendInteractionError(interaction, message) {
  const payload = { content: message, allowedMentions: { parse: [] } };
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (error) {
    console.error(`Could not send an error reply: ${error.message}`);
  }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down (${signal}).`);
  player.shutdown();
  client.destroy();
  setTimeout(() => process.exit(0), 500).unref?.();
}
