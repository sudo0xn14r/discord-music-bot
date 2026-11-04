const { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { UserError } = require('../errors');
const { formatListened, formatTrackLength, oneLine } = require('../format');
const { MAX_QUEUE } = require('../music/queue');
const { tracksFromPlaylist } = require('../music/playlist');
const { resolveRequest } = require('../music/resolver');
const { playerMessage, queueMessage } = require('../panel');

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
  .setDescription('Play a song name or a YouTube, SoundCloud, Bandcamp, Spotify, Apple, or Deezer link')
  .addStringOption(queryOption('Song name or a supported link'));

const k2 = guildOnly(new SlashCommandBuilder())
  .setName('k2')
  .setDescription('Play a song, the same way as /play')
  .addStringOption(queryOption('Song name or a supported link'));

const playnow = guildOnly(new SlashCommandBuilder())
  .setName('playnow')
  .setDescription('Interrupt the current song and play this instead')
  .addStringOption(queryOption('Song name or a supported link'));

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

const stats = guildOnly(new SlashCommandBuilder())
  .setName('stats')
  .setDescription('Show the most played songs, the most active listeners, and total listening time');

const seek = guildOnly(new SlashCommandBuilder())
  .setName('seek')
  .setDescription('Jump to a time in the current track')
  .addStringOption((option) => option
    .setName('position')
    .setDescription('Seconds, or a timestamp like 1:30')
    .setRequired(true)
    .setMaxLength(12));

const loop = guildOnly(new SlashCommandBuilder())
  .setName('loop')
  .setDescription('Repeat the current track or the whole queue')
  .addStringOption((option) => option
    .setName('mode')
    .setDescription('What to loop')
    .setRequired(true)
    .addChoices(
      { name: 'Off', value: 'off' },
      { name: 'Track', value: 'track' },
      { name: 'Queue', value: 'queue' },
    ));

const shuffle = guildOnly(new SlashCommandBuilder())
  .setName('shuffle')
  .setDescription('Shuffle the upcoming songs');

const move = guildOnly(new SlashCommandBuilder())
  .setName('move')
  .setDescription('Move a queued song to another position')
  .addIntegerOption((option) => option
    .setName('from')
    .setDescription('Current position in the queue')
    .setRequired(true)
    .setMinValue(1)
    .setMaxValue(MAX_QUEUE))
  .addIntegerOption((option) => option
    .setName('to')
    .setDescription('New position in the queue')
    .setRequired(true)
    .setMinValue(1)
    .setMaxValue(MAX_QUEUE));

const remove = guildOnly(new SlashCommandBuilder())
  .setName('remove')
  .setDescription('Remove a song from the queue')
  .addIntegerOption((option) => option
    .setName('position')
    .setDescription('Position in the queue')
    .setRequired(true)
    .setMinValue(1)
    .setMaxValue(MAX_QUEUE));

const filter = guildOnly(new SlashCommandBuilder())
  .setName('filter')
  .setDescription('Apply a playback filter')
  .addStringOption((option) => option
    .setName('name')
    .setDescription('Filter')
    .setRequired(true)
    .addChoices(
      { name: 'Off', value: 'off' },
      { name: 'Bass boost', value: 'bassboost' },
      { name: 'Nightcore', value: 'nightcore' },
    ));

const djrole = guildOnly(new SlashCommandBuilder())
  .setName('djrole')
  .setDescription('Limit queue controls to a role. Leave the role empty to clear it.')
  .addRoleOption((option) => option
    .setName('role')
    .setDescription('Role that can control the queue')
    .setRequired(false));

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

function stampRequester(tracks, userId) {
  if (!/^\d{17,20}$/.test(String(userId || ''))) return;
  for (const track of tracks || []) track.requesterId = userId;
}

function playlistName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 40) throw new UserError('Playlist names need 1 to 40 characters.');
  return name;
}

function matchNote(track) {
  const labels = { spotify: 'Spotify', apple: 'Apple Music', deezer: 'Deezer' };
  const from = labels[track?.matchedFrom];
  if (!from) return '';
  const where = {
    local: 'the local library',
    youtube: 'YouTube',
    soundcloud: 'SoundCloud',
    lavalink: 'SoundCloud',
  }[track.source] || 'a playback source';
  if (track.loose) {
    return `No close match, so this is the top ${where} result. ${from} audio is not streamed.`;
  }
  return `Matched the ${from} metadata to ${where}. ${from} audio is not streamed.`;
}

function hasPermission(member, flag) {
  const permissions = member?.permissions;
  if (!permissions || typeof permissions.has !== 'function') return false;
  return permissions.has(flag);
}

function memberHasRole(member, roleId) {
  if (!member || !roleId) return false;
  if (member.roles?.cache?.has?.(roleId)) return true;
  if (Array.isArray(member.roles)) return member.roles.includes(roleId);
  return false;
}

function requireControl(interaction, music) {
  const roleId = music.database.getGuild(interaction.guildId)?.djRoleId;
  if (!roleId) return;
  if (hasPermission(interaction.member, PermissionFlagsBits.ManageGuild)) return;
  if (memberHasRole(interaction.member, roleId)) return;
  throw new UserError('Only a DJ can do that in this server.');
}

function parseSeek(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const parts = text.split(':').map((part) => Number(part));
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((part) => !Number.isInteger(part) || part < 0)) return null;
  if (parts.length === 2 && parts[1] > 59) return null;
  if (parts.length === 3 && (parts[1] > 59 || parts[2] > 59)) return null;
  if (parts.length === 2) return ((parts[0] * 60) + parts[1]) * 1000;
  return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000;
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
  if (now) requireControl(interaction, music);
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
  stampRequester(resolved.tracks, interaction.user.id);
  session.bindTextChannel(interaction.channelId);
  await session.join(voice.id, interaction.guild?.shardId ?? 0);
  const result = await session.add(resolved.tracks, { now });
  if (result?.dropped || result?.outcome?.dropped) {
    await interaction.editReply({ content: 'That play was interrupted.', allowedMentions: { parse: [] } });
    return;
  }
  const message = await interaction.editReply(playerMessage(session, describeAdd(result, resolved.notice)));
  session.notePanel(message);
  await sendPlayGif(interaction, music, result);
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
  requireControl(interaction, music);
  const text = await session.stop();
  await session.refreshPanel(text);
  return interaction.reply(text);
}

async function executeLeave(interaction, music) {
  requireControl(interaction, music);
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
  requireControl(interaction, music);
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
  return interaction.reply(queueMessage(session, 0));
}

async function executeNowPlaying(interaction, music) {
  const session = activeSession(interaction, music);
  if (!session.current) throw new UserError('Nothing is playing right now.');
  const message = await interaction.reply({ ...playerMessage(session), fetchReply: true });
  session.notePanel(message);
}

async function executeVolume(interaction, music) {
  requireControl(interaction, music);
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

async function executeStats(interaction, music) {
  if (!interaction.inGuild()) throw new UserError('This bot only works in a server.');
  music.peek(interaction.guildId)?.touchListen();
  const report = music.database.playStats(interaction.guildId, 5);
  if (!report.plays) return interaction.reply('No songs have been played here yet.');
  const lines = [
    `**${report.plays}** play${report.plays === 1 ? '' : 's'} · ${formatListened(report.playedMs)} listened`,
    '',
    '**Most played**',
  ];
  report.songs.forEach((song, index) => {
    lines.push(`${index + 1}. ${oneLine(song.title)} — ${oneLine(song.artist)} · ${song.plays} play${song.plays === 1 ? '' : 's'} · ${formatListened(song.playedMs)}`);
  });
  lines.push('', '**Most active listeners**');
  report.users.forEach((user, index) => {
    lines.push(`${index + 1}. ${oneLine(user.requesterName)} · ${user.plays} play${user.plays === 1 ? '' : 's'} · ${formatListened(user.playedMs)}`);
  });
  return interaction.reply({ content: lines.join('\n').slice(0, 2000), allowedMentions: { parse: [] } });
}

async function replyWithPanel(interaction, session, text) {
  const message = await interaction.reply({ ...playerMessage(session, text), fetchReply: true });
  session.notePanel(message);
}

async function executeSeek(interaction, music) {
  const session = activeSession(interaction, music);
  requireControl(interaction, music);
  const position = parseSeek(interaction.options.getString('position', true));
  if (position == null) throw new UserError('Use seconds or a timestamp like 1:30.');
  const text = await session.seek(position);
  return replyWithPanel(interaction, session, text);
}

async function executeLoop(interaction, music) {
  const session = activeSession(interaction, music);
  requireControl(interaction, music);
  const text = await session.setLoop(interaction.options.getString('mode', true));
  return replyWithPanel(interaction, session, text);
}

async function executeShuffle(interaction, music) {
  const session = activeSession(interaction, music);
  requireControl(interaction, music);
  const text = await session.shuffleUpcoming();
  return replyWithPanel(interaction, session, text);
}

async function executeMove(interaction, music) {
  const session = activeSession(interaction, music);
  requireControl(interaction, music);
  const text = await session.moveUpcoming(
    interaction.options.getInteger('from', true),
    interaction.options.getInteger('to', true),
  );
  await session.refreshPanel(text);
  return interaction.reply(text);
}

async function executeRemove(interaction, music) {
  const session = activeSession(interaction, music);
  requireControl(interaction, music);
  const text = await session.removeUpcoming(interaction.options.getInteger('position', true));
  await session.refreshPanel(text);
  return interaction.reply(text);
}

async function executeFilter(interaction, music) {
  const session = activeSession(interaction, music);
  requireControl(interaction, music);
  const text = await session.setFilter(interaction.options.getString('name', true));
  return replyWithPanel(interaction, session, text);
}

async function executeDjRole(interaction, music) {
  if (!interaction.inGuild()) throw new UserError('This bot only works in a server.');
  if (!hasPermission(interaction.member, PermissionFlagsBits.ManageGuild)) {
    throw new UserError('You need the Manage Server permission to change the DJ role.');
  }
  const role = interaction.options.getRole('role');
  music.database.setDjRole(interaction.guildId, role ? role.id : null);
  const content = role
    ? `DJ role set to ${oneLine(role.name)}. Anyone can still play, pause, and skip. Other controls need that role or Manage Server.`
    : 'DJ role cleared. Anyone in the voice channel can control playback.';
  return interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
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
  const { tracks, missing } = tracksFromPlaylist(saved.tracks, music.providers, requester);
  stampRequester(tracks, interaction.user.id);
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
  await sendPlayGif(interaction, music, result);
}

async function sendPlayGif(interaction, music, result) {
  const gif = music?.config?.playGifUrl;
  if (!gif || !result?.started || !result.outcome?.ok) return;
  await interaction.followUp({ content: gif, allowedMentions: { parse: [] } });
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
    requireControl(interaction, music);
    await interaction.deferUpdate();
    const text = await session.stop();
    await session.refreshPanel(text);
    return;
  }
  if (action === 'player:loop') {
    requireControl(interaction, music);
    const order = ['off', 'track', 'queue'];
    const next = order[(order.indexOf(session.queue.loopMode) + 1) % order.length];
    const text = await session.setLoop(next);
    await interaction.update(playerMessage(session, text));
    return;
  }
  if (action === 'player:shuffle') {
    requireControl(interaction, music);
    const text = await session.shuffleUpcoming();
    await interaction.update(playerMessage(session, text));
    return;
  }
  if (action.startsWith('queue:')) {
    const page = Number(action.slice('queue:'.length));
    await interaction.update(queueMessage(session, Number.isInteger(page) ? page : 0));
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

const executePlayCommand = (interaction, music) => executePlay(interaction, music);

const commands = [
  { data: play, execute: executePlayCommand },
  { data: k2, execute: executePlayCommand },
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
  { data: stats, execute: executeStats },
  { data: seek, execute: executeSeek },
  { data: loop, execute: executeLoop },
  { data: shuffle, execute: executeShuffle },
  { data: move, execute: executeMove },
  { data: remove, execute: executeRemove },
  { data: filter, execute: executeFilter },
  { data: djrole, execute: executeDjRole },
];

module.exports = { commands, executeButton, sendPlayGif };
