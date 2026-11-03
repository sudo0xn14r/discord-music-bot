const { InteractionContextType, SlashCommandBuilder } = require('discord.js');
const { UserError } = require('../errors');
const { formatTrackLength, oneLine } = require('../format');
const { createTrack } = require('../music/track');
const { MAX_QUEUE } = require('../music/queue');
const { resolveRequest } = require('../music/resolver');
const { playerMessage } = require('../panel');

function guildOnly(builder) {
  return builder.setContexts(InteractionContextType.Guild);
}

const queryOption = (description) => (option) => option
  .setName('query')
  .setDescription(description)
  .setRequired(true)
  .setMaxLength(500);

const play = guildOnly(new SlashCommandBuilder())
  .setName('play')
  .setDescription('Play a song name, a SoundCloud link, or a Spotify link')
  .addStringOption(queryOption('Song name, SoundCloud link, or Spotify link'));

const playnow = guildOnly(new SlashCommandBuilder())
  .setName('playnow')
  .setDescription('Interrupt the current song and play this instead')
  .addStringOption(queryOption('Song name, SoundCloud link, or Spotify link'));

const pause = guildOnly(new SlashCommandBuilder())
  .setName('pause')
  .setDescription('Pause the current track');

const resume = guildOnly(new SlashCommandBuilder())
  .setName('resume')
  .setDescription('Resume the paused track');

const skip = guildOnly(new SlashCommandBuilder())
  .setName('skip')
  .setDescription('Skip the current track');

const stop = guildOnly(new SlashCommandBuilder())
  .setName('stop')
  .setDescription('Stop playback and clear the queue');

const queue = guildOnly(new SlashCommandBuilder())
  .setName('queue')
  .setDescription('Show what is playing and what is queued');

const nowplaying = guildOnly(new SlashCommandBuilder())
  .setName('nowplaying')
  .setDescription('Show the track that is playing');

const leave = guildOnly(new SlashCommandBuilder())
  .setName('leave')
  .setDescription('Leave the voice channel and clear the queue');

const clear = guildOnly(new SlashCommandBuilder())
  .setName('clear')
  .setDescription('Clear the queued songs. The current song keeps playing.');

const volume = guildOnly(new SlashCommandBuilder())
  .setName('volume')
  .setDescription('Set the playback volume for this server')
  .addIntegerOption((option) => option
    .setName('level')
    .setDescription('Volume from 0 to 150')
    .setRequired(true)
    .setMinValue(0)
    .setMaxValue(150));

const playlist = guildOnly(new SlashCommandBuilder())
  .setName('playlist')
  .setDescription('Save or load a playlist for this server')
  .addSubcommand((subcommand) => subcommand
    .setName('save')
    .setDescription('Save the current queue under a name')
    .addStringOption((option) => option
      .setName('name')
      .setDescription('Playlist name')
      .setRequired(true)
      .setMaxLength(40)))
  .addSubcommand((subcommand) => subcommand
    .setName('load')
    .setDescription('Add a saved playlist to the queue')
    .addStringOption((option) => option
      .setName('name')
      .setDescription('Playlist name')
      .setRequired(true)
      .setMaxLength(40)))
  .addSubcommand((subcommand) => subcommand
    .setName('list')
    .setDescription('List saved playlists'))
  .addSubcommand((subcommand) => subcommand
    .setName('delete')
    .setDescription('Delete a saved playlist')
    .addStringOption((option) => option
      .setName('name')
      .setDescription('Playlist name')
      .setRequired(true)
      .setMaxLength(40)));

const history = guildOnly(new SlashCommandBuilder())
  .setName('history')
  .setDescription('Show songs this server played recently');

function userVoice(interaction) {
  if (!interaction.inGuild() || !interaction.guild) {
    throw new UserError('This bot only works in a server.');
  }
  const state = interaction.guild.voiceStates.cache.get(interaction.user.id);
  const channel = state?.channel ?? interaction.member?.voice?.channel ?? null;
  const channelId = channel?.id ?? state?.channelId ?? null;
  if (!channelId) throw new UserError('You need to be in a voice channel to use this command.');
  return { id: channelId, guild: interaction.guild };
}

function sameChannel(interaction, session) {
  const voice = userVoice(interaction);
  if (!session?.channelId) throw new UserError("I'm not in a voice channel.");
  if (session.channelId !== voice.id) throw new UserError('You need to be in the same voice channel as me.');
  return voice;
}

function requestedBy(user) {
  return user.globalName || user.username;
}

function playlistName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 40) throw new UserError('Playlist names need 1 to 40 characters.');
  return name;
}

function matchNote(track) {
  if (track?.matchedFrom !== 'spotify') return '';
  const where = track.source === 'local' ? 'the local library' : 'SoundCloud';
  return `Matched the Spotify metadata to ${where}. Spotify audio is not streamed.`;
}

function describeAdd(result, notice) {
  const lines = [];
  const playing = result.started && result.outcome?.ok ? result.outcome.track : null;
  if (playing) {
    lines.push(`Playing **${oneLine(playing.title)}** (${formatTrackLength(playing.durationMs)}).`);
    const note = matchNote(playing);
    if (note) lines.push(note);
    const queued = Math.max(0, result.accepted.length - 1 - (result.outcome.skipped?.length || 0));
    if (queued > 0) lines.push(`Queued ${queued} more.`);
  } else if (!result.started && result.accepted?.length) {
    const track = result.accepted[0];
    lines.push(`Added **${oneLine(track.title)}** to the queue at position ${result.position}.`);
    if (result.accepted.length > 1) lines.push(`Added ${result.accepted.length - 1} more after it.`);
    const note = matchNote(track);
    if (note) lines.push(note);
  }
  if (result.skipped) lines.push(`${result.skipped} more did not fit in the queue.`);
  for (const item of result.outcome?.skipped || []) {
    lines.push(`Couldn't play **${oneLine(item.title)}**: ${item.reason}`);
  }
  if (result.started && result.outcome?.ok === false && !(result.outcome.skipped || []).length) {
    lines.unshift(`Couldn't start playback: ${result.outcome.reason}`);
  }
  if (notice) lines.push(notice);
  return lines.join('\n') || 'Done.';
}

async function executePlay(interaction, music, { now = false } = {}) {
  const voice = userVoice(interaction);
  const existing = music.peek(interaction.guildId);
  if (existing?.channelId && existing.channelId !== voice.id) {
    throw new UserError('You need to be in the same voice channel as me.');
  }
  const query = interaction.options.getString('query', true);
  const session = music.session(interaction.guildId);
  const room = now ? MAX_QUEUE : session.queue.freeSlots();
  if (!now && room <= 0) {
    throw new UserError(`The queue is full (${MAX_QUEUE} tracks). Skip or stop before adding more.`);
  }
  await interaction.deferReply();
  const resolved = await resolveRequest(query, requestedBy(interaction.user), room, music.providers);
  session.bindTextChannel(interaction.channelId);
  await session.join(voice.id, interaction.guild?.shardId ?? 0);
  const result = await session.add(resolved.tracks, { now });
  if (result?.dropped || result?.outcome?.dropped) {
    await interaction.editReply({ content: 'That play was interrupted.', allowedMentions: { parse: [] } });
    return;
  }
  const message = await interaction.editReply(playerMessage(session, describeAdd(result, resolved.notice)));
  session.notePanel(message);
}

function activeSession(interaction, music) {
  const session = music.peek(interaction.guildId);
  sameChannel(interaction, session);
  session.bindTextChannel(interaction.channelId);
  return session;
}

async function executePause(interaction, music) {
  const session = activeSession(interaction, music);
  return interaction.reply(await session.pause());
}

async function executeResume(interaction, music) {
  const session = activeSession(interaction, music);
  return interaction.reply(await session.resumePlayback());
}

async function executeSkip(interaction, music) {
  const session = activeSession(interaction, music);
  await interaction.deferReply();
  const { skipped, outcome } = await session.skip();
  const lines = [];
  if (skipped) lines.push(`Skipped **${oneLine(skipped.title)}**.`);
  if (outcome?.track) lines.push(`Playing **${oneLine(outcome.track.title)}**.`);
  else if (outcome?.ok === false) lines.push(outcome.reason);
  else lines.push('The queue is empty.');
  lines.push(...session.skippedNotes(outcome));
  const message = await interaction.editReply(playerMessage(session, lines.join('\n')));
  session.notePanel(message);
}

async function executeStop(interaction, music) {
  const session = activeSession(interaction, music);
  const text = await session.stop();
  await session.refreshPanel(text);
  return interaction.reply(text);
}

async function executeLeave(interaction, music) {
  const voice = userVoice(interaction);
  const session = music.peek(interaction.guildId);
  if (!session?.channelId) throw new UserError("I'm not in a voice channel.");
  if (session.channelId !== voice.id) throw new UserError('You need to be in the same voice channel as me.');
  const text = await session.leave();
  await session.refreshPanel(text);
  return interaction.reply(text);
}

async function executeClear(interaction, music) {
  const session = activeSession(interaction, music);
  const count = session.clearUpcoming();
  if (!count) throw new UserError('The queue is already empty.');
  const text = `Cleared ${count} song${count === 1 ? '' : 's'} from the queue.`;
  await session.refreshPanel(text);
  return interaction.reply(text);
}

async function executeQueue(interaction, music) {
  const session = activeSession(interaction, music);
  if (!session.current && session.upcoming.length === 0) {
    throw new UserError('Nothing is playing and the queue is empty.');
  }
  const message = await interaction.reply({ ...playerMessage(session), fetchReply: true });
  session.notePanel(message);
}

async function executeNowPlaying(interaction, music) {
  const session = activeSession(interaction, music);
  if (!session.current) throw new UserError('Nothing is playing right now.');
  const message = await interaction.reply({ ...playerMessage(session), fetchReply: true });
  session.notePanel(message);
}

async function executeVolume(interaction, music) {
  const existing = music.peek(interaction.guildId);
  if (existing?.channelId) sameChannel(interaction, existing);
  const session = music.session(interaction.guildId);
  const level = interaction.options.getInteger('level', true);
  return interaction.reply(await session.setVolume(level));
}

async function executeHistory(interaction, music) {
  if (!interaction.inGuild()) throw new UserError('This bot only works in a server.');
  const rows = music.database.recentHistory(interaction.guildId, 10);
  if (!rows.length) return interaction.reply('No songs have been played here yet.');
  const lines = rows.map((row, index) => `${index + 1}. ${oneLine(row.title)} — ${oneLine(row.artist)}`);
  return interaction.reply({ content: lines.join('\n').slice(0, 2000), allowedMentions: { parse: [] } });
}

async function executePlaylist(interaction, music) {
  if (!interaction.inGuild()) throw new UserError('This bot only works in a server.');
  const sub = interaction.options.getSubcommand();
  if (sub === 'list') {
    const rows = music.database.listPlaylists(interaction.guildId);
    if (!rows.length) return interaction.reply('No playlists are saved on this server.');
    const lines = rows.map((row) => `• ${oneLine(row.name)} (${row.tracks} track${row.tracks === 1 ? '' : 's'})`);
    return interaction.reply({ content: lines.join('\n').slice(0, 2000), allowedMentions: { parse: [] } });
  }
  const name = playlistName(interaction.options.getString('name', true));
  if (sub === 'delete') {
    const removed = music.database.deletePlaylist(interaction.guildId, name);
    if (!removed) throw new UserError(`I don't have a playlist named ${name}.`);
    return interaction.reply(`Deleted playlist **${oneLine(name)}**.`);
  }
  if (sub === 'save') {
    const session = music.peek(interaction.guildId);
    if (session?.channelId) sameChannel(interaction, session);
    const tracks = [session?.current, ...(session?.upcoming || [])].filter(Boolean);
    if (!tracks.length) throw new UserError('Nothing is playing or queued to save.');
    music.database.savePlaylist(interaction.guildId, name, tracks, requestedBy(interaction.user));
    return interaction.reply(`Saved **${tracks.length}** track${tracks.length === 1 ? '' : 's'} to **${oneLine(name)}**.`);
  }
  const saved = music.database.loadPlaylist(interaction.guildId, name);
  if (!saved) throw new UserError(`I don't have a playlist named ${name}.`);
  const voice = userVoice(interaction);
  const existing = music.peek(interaction.guildId);
  if (existing?.channelId && existing.channelId !== voice.id) {
    throw new UserError('You need to be in the same voice channel as me.');
  }
  const requester = requestedBy(interaction.user);
  const tracks = [];
  let missing = 0;
  for (const row of saved.tracks) {
    if (row.source !== 'local' && row.source !== 'soundcloud') {
      missing += 1;
      continue;
    }
    const provider = music.providers.get(row.source);
    if (!provider?.enabled()) {
      missing += 1;
      continue;
    }
    const track = createTrack({ ...row, requester });
    if (track.source === 'local' && !provider.owns(track.filePath || '')) {
      missing += 1;
      continue;
    }
    tracks.push(track);
  }
  if (!tracks.length) {
    throw new UserError('None of the saved tracks are available from an enabled source anymore.');
  }
  await interaction.deferReply();
  const session = music.session(interaction.guildId);
  session.bindTextChannel(interaction.channelId);
  await session.join(voice.id, interaction.guild?.shardId ?? 0);
  const result = await session.add(tracks);
  const notice = missing ? `${missing} saved track${missing === 1 ? '' : 's'} could not be loaded.` : null;
  if (result?.dropped || result?.outcome?.dropped) {
    await interaction.editReply({ content: 'That play was interrupted.', allowedMentions: { parse: [] } });
    return;
  }
  const message = await interaction.editReply(playerMessage(session, describeAdd(result, notice)));
  session.notePanel(message);
}

async function executeButton(interaction, music) {
  const session = music.peek(interaction.guildId);
  sameChannel(interaction, session);
  session.bindTextChannel(interaction.channelId);
  session.notePanel(interaction.message);
  const action = interaction.customId;
  if (action === 'player:pause') {
    const text = session.paused ? await session.resumePlayback() : await session.pause();
    await interaction.update(playerMessage(session, text));
    return;
  }
  if (action === 'player:stop') {
    await interaction.deferUpdate();
    const text = await session.stop();
    await session.refreshPanel(text);
    return;
  }
  if (action === 'player:next') {
    await interaction.deferUpdate();
    const { skipped, outcome } = await session.skip();
    const lines = [];
    if (skipped) lines.push(`Skipped **${oneLine(skipped.title)}**.`);
    if (outcome?.track) lines.push(`Playing **${oneLine(outcome.track.title)}**.`);
    else lines.push('The queue is empty.');
    lines.push(...session.skippedNotes(outcome));
    await session.refreshPanel(lines.join('\n'));
    return;
  }
  if (action === 'player:prev') {
    await interaction.deferUpdate();
    const outcome = await session.previous();
    const lines = [];
    if (outcome?.ok === false && !outcome.dropped) lines.push(`Couldn't play that: ${outcome.reason}`);
    lines.push(...session.skippedNotes(outcome));
    await session.refreshPanel(lines.filter(Boolean).join('\n') || null);
    return;
  }
  throw new UserError('That button is not available.');
}

const commands = [
  { data: play, execute: (interaction, music) => executePlay(interaction, music) },
  { data: playnow, execute: (interaction, music) => executePlay(interaction, music, { now: true }) },
  { data: pause, execute: executePause },
  { data: resume, execute: executeResume },
  { data: skip, execute: executeSkip },
  { data: stop, execute: executeStop },
  { data: clear, execute: executeClear },
  { data: queue, execute: executeQueue },
  { data: nowplaying, execute: executeNowPlaying },
  { data: leave, execute: executeLeave },
  { data: volume, execute: executeVolume },
  { data: playlist, execute: executePlaylist },
  { data: history, execute: executeHistory },
];

module.exports = { commands, executeButton };
