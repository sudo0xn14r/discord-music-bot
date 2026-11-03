const { EmbedBuilder, InteractionContextType, SlashCommandBuilder } = require('discord.js');
const { UserError } = require('./errors');
const { formatDuration, oneLine } = require('./format');
const { matchNote, resolveTracks } = require('./media');
const { playerMessage } = require('./panel');
const { MAX_QUEUE } = require('./player');

function guildOnly(builder) {
  return builder.setContexts(InteractionContextType.Guild);
}

const play = guildOnly(new SlashCommandBuilder())
  .setName('play')
  .setDescription('Play a song name or a link')
  .addStringOption((option) => option
    .setName('query')
    .setDescription('Song name, or a YouTube, Spotify, SoundCloud, Deezer, or other link')
    .setRequired(true)
    .setMaxLength(500));

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
  .setDescription('Show the upcoming tracks');

const nowplaying = guildOnly(new SlashCommandBuilder())
  .setName('nowplaying')
  .setDescription('Show the track that is playing');

const leave = guildOnly(new SlashCommandBuilder())
  .setName('leave')
  .setDescription('Leave the voice channel and clear the queue');

const clear = guildOnly(new SlashCommandBuilder())
  .setName('clear')
  .setDescription('Clear the queued songs. The current song keeps playing.');

const playnow = guildOnly(new SlashCommandBuilder())
  .setName('playnow')
  .setDescription('Interrupt the current song and play this instead')
  .addStringOption((option) => option
    .setName('query')
    .setDescription('Song name, or a YouTube, Spotify, SoundCloud, Deezer, or other link')
    .setRequired(true)
    .setMaxLength(500));

function userVoice(interaction) {
  if (!interaction.inGuild() || !interaction.guild) {
    throw new UserError('This bot only works in a server.');
  }
  const state = interaction.guild.voiceStates.cache.get(interaction.user.id);
  const channel = state?.channel ?? interaction.member?.voice?.channel ?? null;
  const channelId = channel?.id ?? state?.channelId ?? null;
  if (!channelId) {
    throw new UserError('You need to be in a voice channel to use this command.');
  }
  return { id: channelId, guild: interaction.guild };
}

function sameChannel(interaction, session) {
  const voice = userVoice(interaction);
  if (!session?.channelId) {
    throw new UserError("I'm not in a voice channel.");
  }
  if (session.channelId !== voice.id) {
    throw new UserError('You need to be in the same voice channel as me.');
  }
  return voice;
}

function requestedBy(user) {
  return user.globalName || user.username;
}

async function executePlay(interaction, player) {
  const voice = userVoice(interaction);
  const existing = player.peek(interaction.guildId);
  if (existing?.channelId && existing.channelId !== voice.id) {
    throw new UserError('You need to be in the same voice channel as me.');
  }

  const query = interaction.options.getString('query', true);
  const room = player.peek(interaction.guildId)?.freeSlots() ?? MAX_QUEUE;
  if (room <= 0) {
    throw new UserError(`The queue is full (${MAX_QUEUE} tracks). Skip or stop before adding more.`);
  }
  await interaction.deferReply();
  const tracks = await resolveTracks(query, requestedBy(interaction.user), room);
  const session = player.session(interaction.guildId);
  session.bindTextChannel(interaction.channelId);
  await session.join(voice);
  const result = session.enqueueAll(tracks);
  const outcome = result.playback ? await result.playback : { ok: true };
  if (outcome.dropped) {
    await interaction.editReply('That play was interrupted.');
    return;
  }
  if (!outcome.ok) {
    await interaction.editReply(`Couldn't play **${oneLine(result.first.title)}**: ${outcome.reason}`);
    return;
  }
  const message = await interaction.editReply(playerMessage(session, describeAdd(result)));
  session.notePanel(message);
}

async function executePlayNow(interaction, player) {
  const voice = userVoice(interaction);
  const existing = player.peek(interaction.guildId);
  if (existing?.channelId && existing.channelId !== voice.id) {
    throw new UserError('You need to be in the same voice channel as me.');
  }

  const query = interaction.options.getString('query', true);
  await interaction.deferReply();
  const tracks = await resolveTracks(query, requestedBy(interaction.user), MAX_QUEUE);
  const session = player.session(interaction.guildId);
  session.bindTextChannel(interaction.channelId);
  await session.join(voice);
  const result = session.playNow(tracks);
  const outcome = await result.playback;
  if (outcome?.dropped) {
    await interaction.editReply('That play was interrupted.');
    return;
  }
  if (!outcome?.ok) {
    await interaction.editReply(`Couldn't play **${oneLine(result.first.title)}**: ${outcome.reason}`);
    return;
  }
  const note = matchNote(result.first);
  const headline = `Playing **${oneLine(result.first.title)}** now.${note ? `\n${note}` : ''}`;
  const message = await interaction.editReply(playerMessage(session, headline));
  session.notePanel(message);
}

function executeClear(interaction, player) {
  const session = player.peek(interaction.guildId);
  sameChannel(interaction, session);
  const count = session.clearUpcoming();
  if (!count) throw new UserError('The queue is already empty.');
  const text = `Cleared ${count} song${count === 1 ? '' : 's'} from the queue.`;
  void session.refreshPanel(text);
  return interaction.reply(text);
}

async function executeButton(interaction, player) {
  const session = player.peek(interaction.guildId);
  sameChannel(interaction, session);
  session.bindTextChannel(interaction.channelId);
  session.notePanel(interaction.message);
  const action = interaction.customId;

  if (action === 'player:pause') {
    const text = session.player.state.status === 'paused' ? session.resume() : session.pause();
    await interaction.update(playerMessage(session, text));
    return;
  }
  if (action === 'player:stop') {
    await interaction.deferUpdate();
    const text = session.stop();
    await session.refreshPanel(text);
    return;
  }
  if (action === 'player:next') {
    await interaction.deferUpdate();
    const { text, playback } = session.skip();
    const outcome = await playback;
    if (outcome && outcome.ok === false && !outcome.dropped) {
      await session.refreshPanel(`Couldn't play the next song: ${outcome.reason}`);
      return;
    }
    await session.refreshPanel(text);
    return;
  }
  if (action === 'player:prev') {
    await interaction.deferUpdate();
    const outcome = await session.previous();
    if (!outcome.ok && !outcome.dropped) {
      await session.refreshPanel(`Couldn't play that: ${outcome.reason}`);
      return;
    }
    await session.refreshPanel();
    return;
  }
  throw new UserError('That button is not available.');
}

function describeAdd(result) {
  const track = result.first;
  const note = matchNote(track);
  const suffix = note ? `\n${note}` : '';
  if (result.added === 1 && result.started) {
    return `Playing **${oneLine(track.title)}** (${formatDuration(track.duration)}).${suffix}`;
  }
  if (result.added === 1) {
    return `Added **${oneLine(track.title)}** to the queue at position ${result.position}.${suffix}`;
  }
  const extra = result.skipped ? ` ${result.skipped} more did not fit in the queue.` : '';
  const head = result.started
    ? `Playing **${oneLine(track.title)}** and queued ${result.added - 1} more.`
    : `Added ${result.added} tracks to the queue, starting at position ${result.position}.`;
  return `${head}${extra}${suffix}`;
}

function executePause(interaction, player) {
  const session = player.peek(interaction.guildId);
  sameChannel(interaction, session);
  session.bindTextChannel(interaction.channelId);
  return interaction.reply(session.pause());
}

function executeResume(interaction, player) {
  const session = player.peek(interaction.guildId);
  sameChannel(interaction, session);
  session.bindTextChannel(interaction.channelId);
  return interaction.reply(session.resume());
}

async function executeSkip(interaction, player) {
  const session = player.peek(interaction.guildId);
  sameChannel(interaction, session);
  session.bindTextChannel(interaction.channelId);
  await interaction.deferReply();
  const { text, playback } = session.skip();
  const outcome = await playback;
  if (outcome && outcome.ok === false && !outcome.dropped) {
    const message = await interaction.editReply(playerMessage(session, `Couldn't play the next song: ${outcome.reason}`));
    session.notePanel(message);
    return;
  }
  const message = await interaction.editReply(playerMessage(session, text));
  session.notePanel(message);
}

function executeStop(interaction, player) {
  const session = player.peek(interaction.guildId);
  sameChannel(interaction, session);
  session.bindTextChannel(interaction.channelId);
  return interaction.reply(session.stop());
}

function executeQueue(interaction, player) {
  const session = player.peek(interaction.guildId);
  sameChannel(interaction, session);
  if (!session.current && session.tracks.length === 0) {
    throw new UserError('Nothing is playing and the queue is empty.');
  }

  const upcoming = session.tracks.slice(0, 10).map((track, index) => (
    `${index + 1}. ${oneLine(track.title)} (${formatDuration(track.duration)})`
  ));
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Queue')
    .setDescription(upcoming.length ? upcoming.join('\n') : 'No more tracks queued.');

  if (session.current) {
    const status = session.player.state.status === 'paused' ? 'Paused' : 'Now playing';
    embed.addFields({
      name: status,
      value: `${oneLine(session.current.title)} (${formatDuration(session.current.duration)})\nRequested by ${oneLine(session.current.requestedBy)}`,
    });
  }
  if (session.tracks.length > 10) {
    embed.setFooter({ text: `And ${session.tracks.length - 10} more` });
  }
  return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function executeNowPlaying(interaction, player) {
  const session = player.peek(interaction.guildId);
  sameChannel(interaction, session);
  if (!session.current) throw new UserError('Nothing is playing right now.');

  const message = await interaction.reply({ ...playerMessage(session), fetchReply: true });
  session.notePanel(message);
}

function executeLeave(interaction, player) {
  const voice = userVoice(interaction);
  const session = player.peek(interaction.guildId);
  if (!session?.channelId) throw new UserError("I'm not in a voice channel.");
  if (session.channelId !== voice.id) {
    throw new UserError('You need to be in the same voice channel as me.');
  }
  return interaction.reply(session.leave());
}

const commands = [
  { data: play, execute: executePlay },
  { data: playnow, execute: executePlayNow },
  { data: pause, execute: executePause },
  { data: resume, execute: executeResume },
  { data: skip, execute: executeSkip },
  { data: stop, execute: executeStop },
  { data: clear, execute: executeClear },
  { data: queue, execute: executeQueue },
  { data: nowplaying, execute: executeNowPlaying },
  { data: leave, execute: executeLeave },
];

module.exports = { commands, executeButton };
