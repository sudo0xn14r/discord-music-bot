const { createTrack } = require('./track');

function tracksFromPlaylist(rows, providers, requester) {
  const tracks = [];
  let missing = 0;
  for (const row of rows || []) {
    if (row.source === 'lavalink' || row.source === 'youtube') {
      const provider = providers.get(row.source);
      if (!provider?.enabled() || (!row.identifier && !row.pageUrl)) {
        missing += 1;
        continue;
      }
      tracks.push(createTrack({
        ...row,
        requester,
        identifier: row.identifier || row.pageUrl,
      }));
      continue;
    }
    if (row.source !== 'local' && row.source !== 'soundcloud') {
      missing += 1;
      continue;
    }
    const provider = providers.get(row.source);
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
  return { tracks, missing };
}

module.exports = { tracksFromPlaylist };
