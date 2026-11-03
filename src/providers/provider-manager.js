const { queryMatches } = require('./match');
const { LocalLibrary } = require('./local-library');
const { SoundCloudProvider } = require('./soundcloud');
const { SpotifyProvider } = require('./spotify');

const PLAYBACK_PROVIDERS = new Set(['local', 'soundcloud']);

class ProviderManager {
  constructor(config) {
    this.order = config.providerOrder.filter((name) => name !== 'spotify');
    for (const name of config.providerOrder) {
      if (name === 'spotify') {
        console.warn('Spotify is metadata only. It turns on when SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are set, not through PROVIDER_ORDER.');
        continue;
      }
      if (!PLAYBACK_PROVIDERS.has(name)) {
        console.warn(`Unknown provider "${name}" in PROVIDER_ORDER. Expected local or soundcloud.`);
      }
    }
    this.providers = new Map();
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
