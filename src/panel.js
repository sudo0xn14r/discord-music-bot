const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { formatTrackLength, oneLine } = require('./format');

function progressLine(positionMs, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 'Live';
  const ratio = Math.min(1, Math.max(0, (positionMs || 0) / durationMs));
  const width = 16;
  const filled = Math.round(ratio * width);
  const bar = `${'▓'.repeat(filled)}${'░'.repeat(width - filled)}`;
  return `${bar} ${formatTrackLength(durationMs, positionMs)}`;
}

function playerMessage(session, extra) {
  const track = session?.current;
  const upcoming = session?.upcoming || [];
  const embed = new EmbedBuilder().setColor(0x1f6feb);
  if (track) {
    const artist = track.artist && track.artist !== 'Unknown artist' ? oneLine(track.artist) : null;
    const lines = [];
    if (artist) lines.push(artist);
    lines.push(progressLine(session.positionMs, track.durationMs));
    const details = [`Loop ${session.queue?.loopMode || 'off'}`];
    if (session.filter && session.filter !== 'off') details.push(session.filter);
    lines.push(details.join(' · '));
    const next = upcoming.slice(0, 3).map((item, index) => `${index + 1}. ${oneLine(item.title)}`);
    if (next.length) lines.push(next.join('\n'));
    if (upcoming.length > 3) lines.push(`${upcoming.length - 3} more in /queue`);
    embed
      .setTitle(`${session.paused ? 'Paused' : 'Playing'} · ${oneLine(track.title)}`)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: `Requested by ${oneLine(track.requester)}` });
  } else {
    embed.setTitle('Nothing is playing').setDescription('The queue is empty.');
  }

  const idle = !track && upcoming.length === 0;
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('player:pause')
      .setLabel(session?.paused ? 'Resume' : 'Pause')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!track),
    new ButtonBuilder()
      .setCustomId('player:next')
      .setLabel('Skip')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!track),
    new ButtonBuilder()
      .setCustomId('player:loop')
      .setLabel(`Loop ${session?.queue?.loopMode || 'off'}`)
      .setStyle(session?.queue?.loopMode && session.queue.loopMode !== 'off' ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(idle),
    new ButtonBuilder()
      .setCustomId('player:shuffle')
      .setLabel('Shuffle')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(upcoming.length < 2),
    new ButtonBuilder()
      .setCustomId('player:stop')
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(idle),
  );
  const previous = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('player:prev')
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!session?.history?.length),
  );

  return {
    content: extra ? String(extra).slice(0, 2000) : '',
    embeds: [embed],
    components: idle ? [] : [controls, previous],
    allowedMentions: { parse: [] },
  };
}

function queueMessage(session, page = 0) {
  const pageSize = 10;
  const upcoming = session?.upcoming || [];
  const pages = Math.max(1, Math.ceil(upcoming.length / pageSize));
  const index = Math.min(pages - 1, Math.max(0, page));
  const start = index * pageSize;
  const slice = upcoming.slice(start, start + pageSize);
  const lines = [];
  if (session?.current) {
    const artist = session.current.artist && session.current.artist !== 'Unknown artist'
      ? ` — ${oneLine(session.current.artist)}`
      : '';
    lines.push(`Now: ${oneLine(session.current.title)}${artist} (${formatTrackLength(session.current.durationMs, session.positionMs)})`);
  }
  if (!slice.length) lines.push('Nothing else is queued.');
  else {
    lines.push(slice.map((item, itemIndex) => (
      `${start + itemIndex + 1}. ${oneLine(item.title)} (${formatTrackLength(item.durationMs)})`
    )).join('\n'));
  }
  if (pages > 1) lines.push(`Page ${index + 1} of ${pages}`);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`queue:${index - 1}`)
      .setLabel('Previous page')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index <= 0),
    new ButtonBuilder()
      .setCustomId(`queue:${index + 1}`)
      .setLabel('Next page')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index >= pages - 1),
  );
  return {
    content: lines.join('\n').slice(0, 2000),
    components: pages > 1 ? [row] : [],
    allowedMentions: { parse: [] },
  };
}

module.exports = { playerMessage, queueMessage };
