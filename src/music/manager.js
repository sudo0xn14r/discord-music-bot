const { log } = require('../util/log');
const { GuildSession } = require('./player');

class MusicManager {
  constructor({ client, lavalink, database, providers, config }) {
    this.client = client;
    this.lavalink = lavalink;
    this.database = database;
    this.providers = providers;
    this.config = config || {};
    this.sessions = new Map();
    this.restorePromise = null;
    this.idleTimer = null;
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

  startIdleWatch() {
    const minutes = this.config.idleMinutes || 0;
    if (!minutes || this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      void this.checkIdle();
    }, 30000);
    this.idleTimer.unref?.();
  }

  stopIdleWatch() {
    if (!this.idleTimer) return;
    clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  async checkIdle() {
    if (this.restorePromise) {
      try {
        await this.restorePromise;
      } catch {
        // A failed restore should not block the idle check forever.
      }
    }
    const limit = (this.config.idleMinutes || 0) * 60 * 1000;
    if (!limit) return;
    for (const session of this.sessions.values()) {
      if (!session.channelId || session.leaving) {
        session.idleSince = null;
        continue;
      }
      if (!session.isIdle()) {
        session.idleSince = null;
        continue;
      }
      if (!session.idleSince) {
        session.idleSince = Date.now();
        continue;
      }
      if (Date.now() - session.idleSince < limit) continue;
      session.idleSince = null;
      const textChannelId = session.queue?.textChannelId;
      const minutes = this.config.idleMinutes;
      try {
        await session.leave();
        log('info', 'left an idle voice channel', { guildId: session.guildId });
        await this.announce(textChannelId, `I left the voice channel after ${minutes} minutes with nothing playing.`);
      } catch (error) {
        log('error', 'idle leave failed', { guildId: session.guildId, error: error.message });
      }
    }
  }

  restoreAll() {
    if (this.restorePromise) return this.restorePromise;
    if (!this.client.isReady?.() || !this.lavalink.getIdealNode()) return Promise.resolve();
    this.restorePromise = this.restoreSaved().catch((error) => {
      this.restorePromise = null;
      log('error', 'restore failed', { error: error.message });
    });
    return this.restorePromise;
  }

  async restoreSaved() {
    const rows = this.database.listPlayback?.() || [];
    for (const row of rows) {
      try {
        await this.restoreGuild(row);
      } catch (error) {
        log('error', 'could not resume playback', {
          guildId: row.guildId,
          error: error.message,
          node: this.lavalink.getIdealNode?.()?.name,
        });
      }
    }
  }

  async restoreGuild(row) {
    if (!row?.channelId || (!row.current && !(row.upcoming || []).length)) {
      this.database.clearPlayback(row.guildId);
      return;
    }
    const guild = await this.client.guilds.fetch(row.guildId).catch(() => null);
    if (!guild) {
      this.database.clearPlayback(row.guildId);
      return;
    }
    const session = this.session(row.guildId);
    session.skipPersist = true;
    try {
      await session.enqueue(async () => {
        if (session.channelId || session.player) return;
        session.queue.current = row.current || null;
        session.queue.upcoming = Array.isArray(row.upcoming) ? row.upcoming : [];
        session.queue.loopMode = ['off', 'track', 'queue'].includes(row.loopMode) ? row.loopMode : 'off';
        if (Number.isInteger(row.volume)) session.queue.volume = Math.min(150, Math.max(0, row.volume));
        session.positionMs = Number.isFinite(row.positionMs) ? row.positionMs : 0;
        session.filter = ['off', 'bassboost', 'nightcore'].includes(row.filter) ? row.filter : 'off';
        if (row.textChannelId) session.queue.textChannelId = row.textChannelId;
        const seekMs = session.positionMs;
        const pauseAfter = Boolean(row.paused);
        await session.join(row.channelId, guild.shardId ?? 0);
        if (!session.queue.current) session.queue.shiftNext();
        session.generation += 1;
        await session.playCurrent(session.generation, { seekMs, pauseAfter });
        session.persist();
      });
    } finally {
      session.skipPersist = false;
    }
  }

  async announce(channelId, text) {
    if (!channelId || !this.client?.channels?.fetch) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased?.() || !channel.send) return;
      await channel.send({ content: text, allowedMentions: { parse: [] } });
    } catch (error) {
      log('error', 'idle notice failed', { error: error.message });
    }
  }

  async shutdown() {
    this.stopIdleWatch();
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map((session) => session.shutdown()));
  }
}

module.exports = { MusicManager };
