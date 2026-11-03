const { spotifyTarget } = require('./match');
const { fetchJson, friendlyProviderError } = require('../util/http');

class SpotifyProvider {
  constructor(options) {
    this.name = 'spotify';
    this.label = 'Spotify';
    this.canPlay = false;
    this.clientId = options.spotify?.clientId || '';
    this.clientSecret = options.spotify?.clientSecret || '';
    this.token = null;
    this.expiresAt = 0;
  }

  enabled() {
    return Boolean(this.clientId && this.clientSecret);
  }

  async available() {
    return this.enabled();
  }

  status() {
    return this.enabled() ? 'enabled for metadata' : 'disabled, Spotify credentials are not set';
  }

  async ensureToken(force = false) {
    if (!force && this.token && Date.now() < this.expiresAt - 60000) return;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const payload = await fetchJson('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
      attempts: 2,
    });
    if (!payload.access_token) {
      const error = new Error('Spotify did not return an access token.');
      error.status = 401;
      throw error;
    }
    this.token = payload.access_token;
    const lifetime = Number(payload.expires_in) || 3600;
    this.expiresAt = Date.now() + lifetime * 1000;
  }

  async apiGet(pathname) {
    await this.ensureToken();
    const headers = { Authorization: `Bearer ${this.token}` };
    try {
      return await fetchJson(`https://api.spotify.com/v1${pathname}`, { headers });
    } catch (error) {
      if (error.status === 401) {
        this.token = null;
        await this.ensureToken(true);
        return fetchJson(`https://api.spotify.com/v1${pathname}`, {
          headers: { Authorization: `Bearer ${this.token}` },
          attempts: 1,
        });
      }
      throw error;
    }
  }

  metadataFromTrack(track, albumName) {
    if (!track || track.type === 'episode') return null;
    const artists = Array.isArray(track.artists) ? track.artists.map((artist) => artist.name).filter(Boolean) : [];
    return {
      title: track.name,
      artist: artists.join(', '),
      album: albumName || track.album?.name || null,
      durationMs: Number.isFinite(track.duration_ms) ? track.duration_ms : null,
      pageUrl: track.external_urls?.spotify || null,
    };
  }

  async collectPaged(firstPath, mapItem) {
    const items = [];
    let next = firstPath;
    while (next && items.length < 50) {
      const page = await this.apiGet(next);
      const batch = Array.isArray(page.items) ? page.items : [];
      for (const item of batch) {
        const mapped = mapItem(item);
        if (mapped) items.push(mapped);
        if (items.length >= 50) break;
      }
      if (!page.next || items.length >= 50) break;
      const url = new URL(page.next);
      next = `${url.pathname.replace('/v1', '')}${url.search}`;
    }
    return items;
  }

  async resolveMetadata(input) {
    const target = spotifyTarget(input);
    if (!target) {
      const error = new Error('That Spotify link is not a track, album, or playlist.');
      error.userError = true;
      throw error;
    }
    if (target.type === 'episode') return { kind: 'episode', tracks: [] };
    if (target.type === 'track') {
      const track = await this.apiGet(`/tracks/${encodeURIComponent(target.id)}`);
      const metadata = this.metadataFromTrack(track);
      return { kind: 'tracks', tracks: metadata ? [metadata] : [] };
    }
    if (target.type === 'album') {
      const album = await this.apiGet(`/albums/${encodeURIComponent(target.id)}`);
      const tracks = await this.collectPaged(
        `/albums/${encodeURIComponent(target.id)}/tracks?limit=50`,
        (item) => this.metadataFromTrack(item, album.name),
      );
      return { kind: 'tracks', tracks };
    }
    const tracks = await this.collectPaged(
      `/playlists/${encodeURIComponent(target.id)}/tracks?limit=50`,
      (item) => this.metadataFromTrack(item.track),
    );
    return { kind: 'tracks', tracks };
  }

  friendly(error) {
    return friendlyProviderError(error, 'Spotify');
  }
}

module.exports = { SpotifyProvider };
