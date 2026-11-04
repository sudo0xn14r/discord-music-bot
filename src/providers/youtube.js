const { LavalinkSource } = require('./lavalink-source');

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
}

module.exports = { YoutubeProvider };
