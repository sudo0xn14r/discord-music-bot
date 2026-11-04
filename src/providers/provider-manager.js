const { queryMatches } = require('./match');
const { AppleProvider } = require('./apple');
const { DeezerProvider } = require('./deezer');
const { LavalinkSource } = require('./lavalink-source');
const { LocalLibrary } = require('./local-library');
const { SoundCloudProvider } = require('./soundcloud');
const { SpotifyProvider } = require('./spotify');
const { YoutubeProvider } = require('./youtube');

const PLAYBACK_PROVIDERS = new Set(['youtube', 'local', 'soundcloud', 'lavalink']);

class ProviderManager {
  constructor(config, getNode = () => null) {
    this.order = config.providerOrder.filter((name) => !['spotify', 'apple', 'deezer'].includes(name));
    for (const name of config.providerOrder) {
      if (name === 'spotify' || name === 'apple' || name === 'deezer') {
        console.warn(`${name} is metadata only. Playback comes from YouTube, the local library, or SoundCloud.`);
        continue;
      }
      if (!PLAYBACK_PROVIDERS.has(name)) {
        console.warn(`Unknown provider "${name}" in PROVIDER_ORDER. Expected youtube, local, soundcloud, or lavalink.`);
      }
    }
    this.providers = new Map();
    this.register(new YoutubeProvider(getNode, this.order.includes('youtube')));
    this.register(new LocalLibrary({
      localMusicDir: config.localMusicDir,
      enabled: this.order.includes('local'),
    }));
    this.register(new SoundCloudProvider({
      soundcloudClientId: config.soundcloudClientId,
      soundcloudClientSecret: config.soundcloudClientSecret,
      enabled: this.order.includes('soundcloud'),
    }));
    this.register(new SpotifyProvider(config));
    this.register(new AppleProvider());
    this.register(new DeezerProvider());
    this.register(new LavalinkSource(getNode, this.order.includes('lavalink')));
  }

  static fromList(list, order) {
    const manager = Object.create(ProviderManager.prototype);
    manager.order = order;
    manager.providers = new Map(list.map((provider) => [provider.name, provider]));
    return manager;
  }

  register(provider) {
    this.providers.set(provider.name, provider);
  }

  get(name) {
    return this.providers.get(name) || null;
  }

  playbackProviders() {
    const seen = new Set();
    const providers = [];
    for (const name of this.order) {
      const provider = this.providers.get(name);
      if (!provider || !provider.canPlay || seen.has(provider.name) || !provider.enabled()) continue;
      seen.add(provider.name);
      providers.push(provider);
    }
    return providers;
  }

  describe() {
    return [...this.providers.values()].map((provider) => `${provider.name}: ${provider.status()}`);
  }

  async search(query, limit) {
    for (const provider of this.playbackProviders()) {
      try {
        if (!(await provider.available())) continue;
        const found = await provider.search(query, limit);
        const matched = found.filter((track) => queryMatches(query, track));
        if (matched.length) return matched.slice(0, limit);
      } catch (error) {
        console.error(`[provider:${provider.name}] search failed: ${error.message}`);
      }
    }
    return [];
  }

  async findMatch(metadata) {
    for (const provider of this.playbackProviders()) {
      try {
        if (!(await provider.available())) continue;
        const match = await provider.findMatch(metadata);
        if (match) return match;
      } catch (error) {
        console.error(`[provider:${provider.name}] match failed: ${error.message}`);
      }
    }
    return null;
  }

  async searchLoose(query, limit) {
    for (const provider of this.playbackProviders()) {
      if (!provider.allowsLooseMatch || typeof provider.topResults !== 'function') continue;
      try {
        if (!(await provider.available())) continue;
        const found = await provider.topResults(query, limit);
        if (found?.length) return found.slice(0, limit);
      } catch (error) {
        console.error(`[provider:${provider.name}] loose search failed: ${error.message}`);
      }
    }
    return [];
  }

  async looseMatch(metadata) {
    const query = [metadata.artist, metadata.title].filter(Boolean).join(' ').trim();
    if (!query) return null;
    const found = await this.searchLoose(query, 1);
    return found[0] || null;
  }

  async playbackIdentifier(track) {
    const provider = this.providers.get(track.source);
    if (!provider || !provider.canPlay) {
      const error = new Error('That track has no playable source.');
      error.userError = true;
      throw error;
    }
    if (!provider.enabled()) {
      const error = new Error(`${provider.label} is disabled.`);
      error.userError = true;
      throw error;
    }
    return provider.playbackIdentifier(track);
  }
}

module.exports = { ProviderManager };
