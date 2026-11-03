const { createTrack } = require('../music/track');
const { normalize, pickBestMatch, queryMatches } = require('./match');
const { fetchJson, resolveAudioUrl, friendlyProviderError } = require('../util/http');

const API = 'https://api.soundcloud.com';

function selectTranscoding(track) {
  const list = track?.media?.transcodings || [];
  return list.find((item) => (
    item
    && item.url
    && item.snipped !== true
    && item.format?.protocol === 'progressive'
  )) || null;
}

function trackIsPlayable(track) {
  if (!track || track.id == null || !track.title) return false;
  if (track.access === 'blocked' || track.access === 'preview') return false;
  if (track.streamable === false) return false;
  if (selectTranscoding(track)) return true;
  if (Array.isArray(track.media?.transcodings) && track.media.transcodings.length > 0) return false;
  return track.access === 'playable' || track.streamable === true || Boolean(track.stream_url);
}

class SoundCloudProvider {
  constructor(options) {
    this.name = 'soundcloud';
    this.label = 'SoundCloud';
    this.canPlay = true;
    this.clientId = options.soundcloudClientId || '';
    this.clientSecret = options.soundcloudClientSecret || '';
    this.enabledByOrder = options.enabled !== false;
    this.token = null;
    this.expiresAt = 0;
  }

  enabled() {
    return this.enabledByOrder && Boolean(this.clientId);
  }

  async available() {
    return this.enabled();
  }

  status() {
    if (!this.enabledByOrder) return 'disabled by PROVIDER_ORDER';
    if (!this.clientId) return 'disabled, SOUNDCLOUD_CLIENT_ID is not set';
    if (!this.clientSecret) return 'enabled with client id only';
    return 'enabled';
  }

  authHeaders() {
    const headers = { Accept: 'application/json; charset=utf-8' };
    if (this.token) headers.Authorization = `OAuth ${this.token}`;
    return headers;
  }

  async ensureToken(force = false) {
    if (!this.clientSecret) return;
    if (!force && this.token && Date.now() < this.expiresAt - 60000) return;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const payload = await fetchJson('https://secure.soundcloud.com/oauth/token', {
      method: 'POST',
      headers: {
        Accept: 'application/json; charset=utf-8',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      attempts: 2,
    });
    if (!payload.access_token) {
      const error = new Error('SoundCloud did not return an access token.');
      error.status = 401;
      throw error;
    }
    this.token = payload.access_token;
    const lifetime = Number(payload.expires_in) || 3600;
    this.expiresAt = Date.now() + lifetime * 1000;
  }

  async apiGet(pathname, params) {
    await this.ensureToken();
    const url = new URL(`${API}${pathname}`);
    for (const [key, value] of Object.entries(params || {})) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }
    if (!this.token) url.searchParams.set('client_id', this.clientId);
    try {
      return await fetchJson(url, { headers: this.authHeaders() });
    } catch (error) {
      if (error.status === 401 && this.clientSecret) {
        this.token = null;
        await this.ensureToken(true);
        return fetchJson(url, { headers: this.authHeaders(), attempts: 1 });
      }
      throw error;
    }
  }

  collection(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.collection)) return payload.collection;
    return [];
  }

  toTrack(resource, requester) {
    return createTrack({
      title: resource.title,
      artist: resource.user?.username || resource.publisher_metadata?.artist || '',
      durationMs: Number.isFinite(resource.duration) ? resource.duration : null,
      source: 'soundcloud',
      requester,
      pageUrl: resource.permalink_url || null,
      soundcloudId: resource.id,
    });
  }

  async search(query, limit = 1) {
    const payload = await this.apiGet('/tracks', {
      q: query,
      limit: 8,
      access: 'playable',
      linked_partitioning: false,
    });
    const wanted = normalize(query);
    const matches = this.collection(payload)
      .filter(trackIsPlayable)
      .map((resource) => this.toTrack(resource))
      .filter((track) => queryMatches(query, track));
    matches.sort((left, right) => {
      const leftExact = normalize(left.title) === wanted ? 0 : 1;
      const rightExact = normalize(right.title) === wanted ? 0 : 1;
      return leftExact - rightExact;
    });
    return matches.slice(0, limit);
  }

  async findMatch(metadata) {
    const query = [metadata.artist, metadata.title].filter(Boolean).join(' ').trim();
    if (!query) return null;
    const payload = await this.apiGet('/tracks', {
      q: query,
      limit: 8,
      access: 'playable',
      linked_partitioning: false,
    });
    const candidates = this.collection(payload)
      .filter(trackIsPlayable)
      .map((resource) => this.toTrack(resource));
    return pickBestMatch(metadata, candidates);
  }

  async resolveUrl(input, requester, limit = 50) {
    const payload = await this.apiGet('/resolve', { url: input });
    if (payload?.kind === 'playlist' || Array.isArray(payload?.tracks)) {
      const items = Array.isArray(payload.tracks) ? payload.tracks : [];
      const playable = items.filter(trackIsPlayable);
      const selected = playable.slice(0, limit);
      return {
        tracks: selected.map((resource) => this.toTrack(resource, requester)),
        restricted: items.length - playable.length,
        truncated: playable.length > selected.length,
      };
    }
    if (!trackIsPlayable(payload)) {
      const error = new Error('SoundCloud does not make that track available to stream.');
      error.userError = true;
      throw error;
    }
    return { tracks: [this.toTrack(payload, requester)], restricted: 0, truncated: false };
  }

  async playbackIdentifier(track) {
    if (!track.soundcloudId) {
      const error = new Error('That SoundCloud track is missing an id.');
      error.userError = true;
      throw error;
    }
    const resource = await this.apiGet(`/tracks/${encodeURIComponent(track.soundcloudId)}`);
    if (!trackIsPlayable(resource)) {
      const error = new Error('SoundCloud does not make that track available to stream.');
      error.userError = true;
      throw error;
    }
    const transcoding = selectTranscoding(resource);
    const headers = this.authHeaders();
    if (transcoding) {
      return resolveAudioUrl(transcoding.url, headers);
    }
    if (resource.stream_url) {
      const streamUrl = new URL(resource.stream_url);
      if (!this.token) streamUrl.searchParams.set('client_id', this.clientId);
      return resolveAudioUrl(streamUrl.toString(), headers);
    }
    const error = new Error('SoundCloud did not provide a full stream for that track.');
    error.userError = true;
    throw error;
  }

  friendly(error) {
    return friendlyProviderError(error, 'SoundCloud');
  }
}

module.exports = { SoundCloudProvider, selectTranscoding, trackIsPlayable };
