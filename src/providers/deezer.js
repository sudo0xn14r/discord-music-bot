const { fetchJson, friendlyProviderError } = require('../util/http');

function deezerTarget(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const kindIndex = parts.findIndex((part) => ['track', 'album', 'playlist'].includes(part));
  if (kindIndex === -1 || !/^\d+$/.test(parts[kindIndex + 1] || '')) return null;
  return { type: parts[kindIndex], id: parts[kindIndex + 1] };
}

class DeezerProvider {
  constructor() {
    this.name = 'deezer';
    this.label = 'Deezer';
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

  metadataFromTrack(track) {
    if (!track || track.type === 'episode') return null;
    return {
      title: track.title,
      artist: track.artist?.name || '',
      album: track.album?.title || null,
      durationMs: Number.isFinite(track.duration) ? track.duration * 1000 : null,
      pageUrl: track.link || null,
    };
  }

  async collect(path, mapItem) {
    const payload = await fetchJson(`https://api.deezer.com${path}`);
    if (payload.error) {
      const error = new Error('That Deezer link is unavailable.');
      error.status = payload.error.code === 800 ? 404 : 502;
      throw error;
    }
    if (payload.title && !Array.isArray(payload.data) && !payload.tracks) {
      const one = mapItem(payload);
      return one ? [one] : [];
    }
    const list = payload.tracks?.data || payload.data || [];
    return list.map(mapItem).filter(Boolean).slice(0, 50);
  }

  async resolveMetadata(input) {
    const target = deezerTarget(input);
    if (!target) {
      const error = new Error('That Deezer link is not a track, album, or playlist.');
      error.userError = true;
      throw error;
    }
    if (target.type === 'track') {
      const tracks = await this.collect(`/track/${encodeURIComponent(target.id)}`, (item) => this.metadataFromTrack(item));
      return { kind: 'tracks', tracks };
    }
    const path = target.type === 'album'
      ? `/album/${encodeURIComponent(target.id)}`
      : `/playlist/${encodeURIComponent(target.id)}`;
    const payload = await fetchJson(`https://api.deezer.com${path}`);
    if (payload.error) {
      const error = new Error('That Deezer link is unavailable.');
      error.status = 404;
      throw error;
    }
    const list = payload.tracks?.data || [];
    return { kind: 'tracks', tracks: list.map((item) => this.metadataFromTrack(item)).filter(Boolean).slice(0, 50) };
  }

  friendly(error) {
    return friendlyProviderError(error, 'Deezer');
  }
}

module.exports = { DeezerProvider, deezerTarget };
