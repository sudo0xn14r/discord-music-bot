const { GuildSession } = require('./player');

class MusicManager {
  constructor({ client, lavalink, database, providers }) {
    this.client = client;
    this.lavalink = lavalink;
    this.database = database;
    this.providers = providers;
    this.sessions = new Map();
  }

  session(guildId) {
    let existing = this.sessions.get(guildId);
    if (!existing) {
      existing = new GuildSession(this, guildId);
      this.sessions.set(guildId, existing);
    }
    return existing;
  }

  peek(guildId) {
    return this.sessions.get(guildId) || null;
  }

  async shutdown() {
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map((session) => session.shutdown()));
  }
}

module.exports = { MusicManager };
