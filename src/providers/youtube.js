const { createTrack } = require('../music/track');
const { LavalinkSource } = require('./lavalink-source');
const { youtubeVideoId } = require('./match');

class YoutubeProvider extends LavalinkSource {
  constructor(getNode, enabled) {
    super(getNode, enabled);
    this.name = 'youtube';
    this.label = 'YouTube';
    this.sourceName = 'youtube';
    this.allowsLooseMatch = true;
  }

  searchPrefix() {
    return 'ytsearch:';
  }

  async resolveUrl(input, requester, limit = 50) {
    try {
      return await super.resolveUrl(input, requester, limit);
    } catch (error) {
      const id = youtubeVideoId(input);
      const track = id ? await this.trackForVideo(id, requester) : null;
      if (!track) throw error;
      return { tracks: [track], restricted: 0, truncated: false };
    }
  }

  async trackForVideo(id, requester) {
    const page = `https://www.youtube.com/watch?v=${id}`;
    const queries = [];
    try {
      const response = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(page)}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const body = await response.json();
        const query = [body.author_name, body.title].map((part) => String(part || '').trim()).filter(Boolean).join(' ');
        if (query) queries.push(query);
      }
    } catch {
      // A failed title lookup still leaves the watch URL search below.
    }
    queries.push(page);
    for (const query of queries) {
      const tracks = await this.collectSearch(query);
      const match = tracks.find((track) => String(track.identifier || '').includes(id));
      if (match) return createTrack({ ...match, requester });
    }
    return null;
  }
}

module.exports = { YoutubeProvider };
