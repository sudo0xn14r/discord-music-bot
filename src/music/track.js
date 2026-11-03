function clean(value, fallback) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.slice(0, 300);
}

function createTrack(fields) {
  const durationMs = Number.isFinite(fields.durationMs) && fields.durationMs >= 0
    ? Math.floor(fields.durationMs)
    : null;
  return {
    title: clean(fields.title, 'Unknown title'),
    artist: clean(fields.artist, 'Unknown artist'),
    album: fields.album ? clean(fields.album, '') : null,
    durationMs,
    source: fields.source,
    requester: clean(fields.requester, 'Someone'),
    pageUrl: fields.pageUrl || null,
    filePath: fields.filePath || null,
    soundcloudId: fields.soundcloudId ? String(fields.soundcloudId) : null,
    identifier: fields.identifier || null,
    matchedFrom: fields.matchedFrom || null,
  };
}

module.exports = { createTrack };
