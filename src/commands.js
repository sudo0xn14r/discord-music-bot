const { EmbedBuilder, InteractionContextType, MessageFlags, SlashCommandBuilder } = require('discord.js');
const { UserError } = require('./errors');
const { formatDuration, oneLine } = require('./format');
const { matchNote, resolveTracks } = require('./media');
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
  await interaction.editReply({
    content: describeAdd(result),
    flags: MessageFlags.SuppressEmbeds,
  });
}

function describeAdd(result) {
  const track = result.first;
  const note = matchNote(track);
  const suffix = note ? `\n${note}` : '';
  if (result.added === 1 && result.started) {
    return `Playing **${oneLine(track.title)}** (${formatDuration(track.duration)}).${suffix}\n${track.url}`;
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

function executeSkip(interaction, player) {
  const session = player.peek(interaction.guildId);
  sameChannel(interaction, session);
  session.bindTextChannel(interaction.channelId);
  return interaction.reply({ content: session.skip(), allowedMentions: { parse: [] } });
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

function executeNowPlaying(interaction, player) {
  const session = player.peek(interaction.guildId);
  sameChannel(interaction, session);
  if (!session.current) throw new UserError('Nothing is playing right now.');

  const status = session.player.state.status;
  const label = status === 'paused' ? 'Paused' : status === 'buffering' ? 'Starting' : 'Playing';
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(oneLine(session.current.title))
    .setURL(session.current.url)
    .setDescription(`${label} · ${formatDuration(session.current.duration)}\nRequested by ${oneLine(session.current.requestedBy)}`)
    .setFooter({ text: session.tracks.length ? `${session.tracks.length} queued` : 'YouTube' });
  return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
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
  { data: pause, execute: executePause },
  { data: resume, execute: executeResume },
  { data: skip, execute: executeSkip },
  { data: stop, execute: executeStop },
  { data: queue, execute: executeQueue },
  { data: nowplaying, execute: executeNowPlaying },
  { data: leave, execute: executeLeave },
];

module.exports = { commands };
