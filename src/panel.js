const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { formatTrackLength, oneLine } = require('./format');

function playerMessage(session, extra) {
  const lines = [];
  if (extra) lines.push(extra);
  const track = session?.current;
  if (track) {
    const label = session.paused ? 'Paused' : 'Playing';
    const artist = track.artist && track.artist !== 'Unknown artist' ? ` — ${oneLine(track.artist)}` : '';
    lines.push(`**${label}:** ${oneLine(track.title)}${artist} (${formatTrackLength(track.durationMs, session.positionMs)})`);
    lines.push(`Requested by ${oneLine(track.requester)}`);
  } else if (!extra) {
    lines.push('Nothing is playing.');
  }
  const upcoming = session?.upcoming?.slice(0, 8) || [];
  if (upcoming.length) {
    lines.push(upcoming.map((item, index) => (
      `${index + 1}. ${oneLine(item.title)} (${formatTrackLength(item.durationMs)})`
    )).join('\n'));
    if (session.upcoming.length > upcoming.length) {
      lines.push(`And ${session.upcoming.length - upcoming.length} more.`);
    }
  }
  const content = lines.join('\n').slice(0, 2000);
  const idle = !track && !upcoming.length;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('player:prev')
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!session?.history?.length),
    new ButtonBuilder()
      .setCustomId('player:pause')
      .setLabel(session?.paused ? 'Resume' : 'Pause')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!track),
    new ButtonBuilder()
      .setCustomId('player:next')
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!track),
    new ButtonBuilder()
      .setCustomId('player:stop')
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(idle),
  );
  return {
    content,
    components: idle ? [] : [row],
    flags: MessageFlags.SuppressEmbeds,
    allowedMentions: { parse: [] },
  };
}

module.exports = { playerMessage };
