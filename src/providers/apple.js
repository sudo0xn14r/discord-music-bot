const { fetchJson, friendlyProviderError } = require('../util/http');

function appleTarget(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const kindIndex = parts.findIndex((part) => ['song', 'album', 'playlist'].includes(part));
  if (kindIndex === -1) return null;
  const kind = parts[kindIndex];
  const id = parts[kindIndex + 2] || parts[kindIndex + 1];
  if (!id || !/^\d+$/.test(id)) {
    if (kind === 'playlist') return { type: 'playlist', id: parts[kindIndex + 1] || '' };
    return null;
  }
  const trackId = url.searchParams.get('i');
  if (kind === 'album' && trackId && /^\d+$/.test(trackId)) return { type: 'track', id: trackId };
  if (kind === 'song') return { type: 'track', id };
  if (kind === 'album') return { type: 'album', id };
  return { type: 'playlist', id };
}

class AppleProvider {
  constructor() {
    this.name = 'apple';
    this.label = 'Apple Music';
    this.canPlay = false;
  }

  enabled() {
    return true;
  }

  async available() {
    return true;
  }

  status() {
    return 'enabled for metadata';
  }

  metadataFromItem(item) {
    if (!item || item.wrapperType === 'collection') return null;
    return {
      title: item.trackName || item.collectionName,
      artist: item.artistName || '',
      album: item.collectionName || null,
      durationMs: Number.isFinite(item.trackTimeMillis) ? item.trackTimeMillis : null,
      pageUrl: item.trackViewUrl || item.collectionViewUrl || null,
    };
  }

  async resolveMetadata(input) {
    const target = appleTarget(input);
    if (!target) {
      const error = new Error('That Apple Music link is not a song or album.');
      error.userError = true;
      throw error;
    }
    if (target.type === 'playlist') {
      const error = new Error('Apple Music playlists are not supported. Try a song or album link, or /play the song name.');
      error.userError = true;
      throw error;
    }
    const lookupId = encodeURIComponent(target.id);
    const extra = target.type === 'album' ? '&entity=song' : '';
    const payload = await fetchJson(`https://itunes.apple.com/lookup?id=${lookupId}${extra}`);
    const results = Array.isArray(payload.results) ? payload.results : [];
    const tracks = results.map((item) => this.metadataFromItem(item)).filter(Boolean).slice(0, 50);
    return { kind: 'tracks', tracks };
  }

  friendly(error) {
    return friendlyProviderError(error, 'Apple Music');
  }
}

module.exports = { AppleProvider, appleTarget };
