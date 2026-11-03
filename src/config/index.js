const path = require('node:path');

const root = path.join(__dirname, '..', '..');

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

function required(name) {
  const value = readEnv(name);
  if (!value) {
    console.error(`${name} is missing. Copy .env.example to .env and set it.`);
    process.exit(1);
  }
  return value;
}

function integer(name, fallback) {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    console.error(`${name} must be an integer.`);
    process.exit(1);
  }
  return value;
}

function port(name, fallback) {
  const value = integer(name, fallback);
  if (value < 1 || value > 65535) {
    console.error(`${name} must be a port from 1 to 65535.`);
    process.exit(1);
  }
  return value;
}

function loadConfig() {
  const guildId = readEnv('GUILD_ID');
  if (guildId && !/^\d{17,20}$/.test(guildId)) {
    console.error('GUILD_ID must be a Discord server id, or left empty.');
    process.exit(1);
  }
  const ownerId = readEnv('OWNER_ID');
  if (ownerId && !/^\d{17,20}$/.test(ownerId)) {
    console.error('OWNER_ID must be a Discord user id, or left empty.');
    process.exit(1);
  }
  const providerOrder = (readEnv('PROVIDER_ORDER') || 'local,soundcloud,lavalink')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  return {
    root,
    token: required('DISCORD_TOKEN'),
    guildId,
    ownerId,
    lavalink: {
      name: 'main',
      host: readEnv('LAVALINK_HOST') || '127.0.0.1',
      port: port('LAVALINK_PORT', 2333),
      password: required('LAVALINK_PASSWORD'),
      secure: readEnv('LAVALINK_SECURE') === 'true',
    },
    soundcloudClientId: readEnv('SOUNDCLOUD_CLIENT_ID'),
    soundcloudClientSecret: readEnv('SOUNDCLOUD_CLIENT_SECRET'),
    spotify: {
      clientId: readEnv('SPOTIFY_CLIENT_ID'),
      clientSecret: readEnv('SPOTIFY_CLIENT_SECRET'),
    },
    localMusicDir: path.resolve(root, readEnv('LOCAL_MUSIC_DIR') || 'music'),
    databasePath: path.resolve(root, readEnv('DATABASE_PATH') || 'data/bot.sqlite'),
    providerOrder,
    idleMinutes: Math.max(0, integer('IDLE_MINUTES', 10)),
    uptimeUrl: readEnv('UPTIME_URL'),
  };
}

module.exports = { loadConfig, readEnv };
