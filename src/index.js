const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client, Events, GatewayIntentBits, REST, Routes } = require('discord.js');
const { loadConfig } = require('./config');
const { commands } = require('./commands');
const { openDatabase } = require('./db');
const { attachInteractions } = require('./events/interactions');
const { createLavalink } = require('./lavalink/client');
const { startHealth } = require('./lavalink/health');
const { MusicManager } = require('./music/manager');
const { ProviderManager } = require('./providers/provider-manager');

const config = loadConfig();
const database = openDatabase(config.databasePath);
fs.mkdirSync(config.localMusicDir, { recursive: true });
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
  allowedMentions: { parse: [] },
});

const lavalink = createLavalink(client, config);
const providers = new ProviderManager(config);
const music = new MusicManager({ client, lavalink, database, providers });
attachInteractions(client, music);
const stopHealth = startHealth({ lavalink, client, config });
let shuttingDown = false;

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}.`);
  for (const line of providers.describe()) console.log(`[provider] ${line}`);
  try {
    await registerCommands(readyClient.application.id);
  } catch (error) {
    console.error(`Slash command registration failed: ${error.message}`);
  }
});

client.on('error', (error) => {
  console.error(`Discord client error: ${error.message}`);
});

process.on('unhandledRejection', (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`Unhandled rejection: ${message}`);
});

process.on('uncaughtException', (error) => {
  console.error(`Uncaught exception: ${error.stack || error.message}`);
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(config.token).catch((error) => {
  console.error(`Login failed: ${error.message}`);
  process.exit(1);
});

async function registerCommands(applicationId) {
  const rest = new REST({ version: '10' }).setToken(config.token);
  const body = commands.map((command) => command.data.toJSON());
  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(applicationId, config.guildId), { body });
    console.log(`Registered ${body.length} slash commands in guild ${config.guildId}.`);
    return;
  }
  await rest.put(Routes.applicationCommands(applicationId), { body });
  console.log(`Registered ${body.length} global slash commands. They can take up to an hour to appear.`);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down (${signal}).`);
  const timer = setTimeout(() => process.exit(0), 5000);
  timer.unref?.();
  Promise.resolve()
    .then(() => stopHealth())
    .then(() => music.shutdown())
    .then(() => database.close())
    .catch((error) => console.error(`Shutdown error: ${error.message}`))
    .finally(() => {
      client.destroy();
      process.exit(0);
    });
}
