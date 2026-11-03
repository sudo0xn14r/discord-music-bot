const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { formatDuration, oneLine } = require('./format');

function playerMessage(session, extra) {
  const lines = [];
  if (extra) lines.push(extra);
  const track = session?.current;
  if (track) {
    const status = session.player.state.status;
    const label = status === 'paused' ? 'Paused' : status === 'buffering' ? 'Starting' : 'Playing';
    lines.push(`**${label}:** ${oneLine(track.title)} (${formatDuration(track.duration)})`);
  } else if (!extra) {
    lines.push('Nothing is playing.');
  }
  const upcoming = session?.tracks?.slice(0, 8) || [];
  if (upcoming.length) {
    lines.push(upcoming.map((item, index) => `${index + 1}. ${oneLine(item.title)} (${formatDuration(item.duration)})`).join('\n'));
    if (session.tracks.length > upcoming.length) {
      lines.push(`And ${session.tracks.length - upcoming.length} more.`);
    }
  }
  const content = lines.join('\n').slice(0, 2000);
  const canGoBack = Boolean(session?.history?.length);
  const canSkip = Boolean(track);
  const canPause = Boolean(track);
  const paused = session?.player?.state?.status === 'paused';
  const idle = !track && !(session?.tracks?.length);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('player:prev')
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canGoBack),
    new ButtonBuilder()
      .setCustomId('player:pause')
      .setLabel(paused ? 'Resume' : 'Pause')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!canPause),
    new ButtonBuilder()
      .setCustomId('player:next')
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canSkip),
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
