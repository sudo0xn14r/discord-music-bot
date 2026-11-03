const { createTrack } = require('../music/track');
const { pickBestMatch, queryMatches } = require('./match');
const { assertPublicUrl } = require('../util/http');
const { log } = require('../util/log');

function canonicalIdentifier(value) {
  const clean = assertPublicUrl(value);
  const url = new URL(clean);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'm.soundcloud.com') url.hostname = 'soundcloud.com';
  return url.toString();
}

function fromLavalinkTrack(track, requester) {
  const info = track?.info || {};
  return createTrack({
    title: info.title,
    artist: info.author,
    durationMs: Number.isFinite(info.length) ? info.length : null,
    source: 'lavalink',
    requester,
    pageUrl: info.uri || null,
    identifier: info.uri || null,
  });
}

class LavalinkSource {
  constructor(getNode, enabled) {
    this.name = 'lavalink';
    this.label = 'SoundCloud';
    this.canPlay = true;
    this.getNode = getNode;
    this.isEnabled = enabled !== false;
  }

  enabled() {
    return this.isEnabled;
  }

  async available() {
    return this.enabled() && Boolean(this.getNode());
  }

  status() {
    if (!this.enabled()) return 'disabled by PROVIDER_ORDER';
    return this.getNode() ? 'enabled' : 'enabled, waiting for Lavalink';
  }

  node() {
    const node = this.getNode();
    if (!node) {
      const error = new Error('The audio server is not connected.');
      error.userError = true;
      throw error;
    }
    return node;
  }

  async load(identifier) {
    try {
      return await this.node().rest.resolve(identifier);
    } catch (error) {
      log('error', 'Lavalink resolve failed', { source: 'lavalink', error: error.message });
      throw error;
    }
  }

  async search(query, limit = 1) {
    let response;
    try {
      response = await this.load(`scsearch:${query}`);
    } catch (error) {
      if (error.userError) return [];
      throw error;
    }
    if (!response || response.loadType !== 'search' || !Array.isArray(response.data)) return [];
    return response.data
      .map((track) => fromLavalinkTrack(track))
      .filter((track) => track.identifier && queryMatches(query, track))
      .slice(0, limit);
  }

  async findMatch(metadata) {
    const query = [metadata.artist, metadata.title].filter(Boolean).join(' ').trim();
    if (!query) return null;
    let response;
    try {
      response = await this.load(`scsearch:${query}`);
    } catch (error) {
      if (error.userError) return null;
      throw error;
    }
    if (!response || response.loadType !== 'search' || !Array.isArray(response.data)) return null;
    const candidates = response.data
      .map((track) => fromLavalinkTrack(track))
      .filter((track) => track.identifier);
    return pickBestMatch(metadata, candidates);
  }

  async resolveUrl(input, requester, limit = 50) {
    const identifier = canonicalIdentifier(input);
    const response = await this.load(identifier);
    if (!response || response.loadType === 'empty') {
      const error = new Error('That link did not have playable audio.');
      error.userError = true;
      throw error;
    }
    if (response.loadType === 'error') {
      log('error', 'Lavalink could not load a link', {
        source: 'lavalink',
        error: response.data?.message || 'unknown',
      });
      const error = new Error('That link could not be played.');
      error.userError = true;
      throw error;
    }
    if (response.loadType === 'track') {
      const track = fromLavalinkTrack(response.data, requester);
      if (!track.identifier) track.identifier = identifier;
      return { tracks: [track], restricted: 0, truncated: false };
    }
    const list = response.loadType === 'playlist'
      ? response.data?.tracks || []
      : response.loadType === 'search'
        ? response.data || []
        : [];
    const tracks = list.map((item) => fromLavalinkTrack(item, requester)).filter((track) => track.identifier);
    const selected = tracks.slice(0, limit);
    if (!selected.length) {
      const error = new Error('That link did not have playable audio.');
      error.userError = true;
      throw error;
    }
    return { tracks: selected, restricted: 0, truncated: tracks.length > selected.length };
  }

  async playbackIdentifier(track) {
    if (!track.identifier) {
      const error = new Error('That track has no playable address.');
      error.userError = true;
      throw error;
    }
    assertPublicUrl(track.identifier);
    return canonicalIdentifier(track.identifier);
  }

  friendly(error) {
    return error?.userError ? error.message : 'That link could not be played.';
  }
}

module.exports = { LavalinkSource, fromLavalinkTrack };
