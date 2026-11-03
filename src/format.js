function oneLine(value) {
  const text = String(value || 'Unknown title')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[*`]/g, '')
    .trim();
  return text.slice(0, 200) || 'Unknown title';
}

function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return 'live';
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (number) => String(number).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`;
  return `${minutes}:${pad(secs)}`;
}

function formatTrackLength(durationMs, positionMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'unknown length';
  const total = formatDuration(durationMs / 1000);
  if (!Number.isFinite(positionMs) || positionMs < 0) return total;
  return `${formatDuration(positionMs / 1000)} / ${total}`;
}

function shortError(error) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Unknown error';
}

module.exports = { oneLine, formatDuration, formatTrackLength, shortError };
