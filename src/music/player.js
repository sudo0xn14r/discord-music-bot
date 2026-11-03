const { UserError } = require('../errors');
const { oneLine } = require('../format');
const { bindPlayerEvents } = require('../lavalink/events');
const { playerMessage } = require('../panel');
const { log } = require('../util/log');
const { GuildQueue, MAX_QUEUE } = require('./queue');

const MAX_CONSECUTIVE_FAILURES = 3;

class GuildSession {
  constructor(manager, guildId) {
    this.manager = manager;
    this.guildId = guildId;
    this.queue = new GuildQueue(guildId);
    this.channelId = null;
    this.player = null;
    this.paused = false;
    this.positionMs = 0;
    this.panel = null;
    this.panelErrorLogged = false;
    this.generation = 0;
    this.playGeneration = -1;
    this.starting = false;
    this.leaving = false;
    this.tail = Promise.resolve();
    this.filter = 'off';
    this.idleSince = null;
    this.lastPositionSave = 0;
    this.skipPersist = false;
    this.pendingSeekMs = 0;
    const stored = manager.database.getGuild(guildId);
    if (Number.isInteger(stored?.volume)) this.queue.volume = clampVolume(stored.volume);
    if (stored?.textChannelId) this.queue.textChannelId = stored.textChannelId;
  }

  get current() {
    return this.queue.current;
  }

  get upcoming() {
    return this.queue.upcoming;
  }

  get history() {
    return this.queue.history;
  }

  enqueue(task) {
    const run = async () => {
      try {
        return await task();
      } finally {
        if (!this.skipPersist) this.persist();
      }
    };
    const next = this.tail.then(run, run);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  snapshot() {
    return {
      channelId: this.channelId,
      textChannelId: this.queue.textChannelId,
      positionMs: this.positionMs,
      paused: this.paused,
      loopMode: this.queue.loopMode,
      volume: this.queue.volume,
      filter: this.filter,
      current: this.queue.current,
      upcoming: this.queue.upcoming,
    };
  }

  persist() {
    const database = this.manager?.database;
    if (!database?.savePlayback) return;
    try {
      if (!this.channelId || (!this.queue.current && this.queue.upcoming.length === 0)) {
        database.clearPlayback(this.guildId);
        return;
      }
      database.savePlayback(this.guildId, this.snapshot());
    } catch (error) {
      console.error(`[db] playback save failed: ${error.message}`);
    }
  }

  notePosition(positionMs) {
    this.positionMs = positionMs;
    const now = Date.now();
    if (now - this.lastPositionSave < 15000) return;
    this.lastPositionSave = now;
    this.persist();
  }

  displayTitle(track) {
    return oneLine(track?.title);
  }

  skippedNotes(outcome) {
    return (outcome?.skipped || []).map((item) => `Couldn't play **${oneLine(item.title)}**: ${item.reason}`);
  }

  bindTextChannel(channelId) {
    this.queue.textChannelId = channelId;
    try {
      this.manager.database.setTextChannel(this.guildId, channelId);
    } catch (error) {
      console.error(`[db] could not store the text channel: ${error.message}`);
    }
  }

  notePanel(message) {
    if (!message?.id || !message.channelId) return;
    this.panel = { channelId: message.channelId, messageId: message.id };
  }

  node() {
    const node = this.manager.lavalink.getIdealNode();
    if (!node) throw new UserError('The audio server is not connected. Wait a moment and try again.');
    return node;
  }

  async join(channelId, shardId) {
    const existing = this.manager.lavalink.players.get(this.guildId);
    const connection = this.manager.lavalink.connections.get(this.guildId);
    const liveChannel = connection?.channelId || this.channelId;
    if (existing && connection && liveChannel === channelId) {
      this.player = existing;
      this.channelId = channelId;
      this.leaving = false;
      bindPlayerEvents(existing, this);
      return existing;
    }
    if (connection && liveChannel && liveChannel !== channelId) {
      throw new UserError('You need to be in the same voice channel as me.');
    }
    if (connection) {
      throw new UserError('I am already connecting to voice in this server. Try again in a moment.');
    }
    let player;
    try {
      player = await this.manager.lavalink.joinVoiceChannel({
        guildId: this.guildId,
        channelId,
        shardId,
        deaf: true,
      });
    } catch (error) {
      console.error(`[lavalink] join failed: ${error.message}`);
      throw new UserError('I could not connect to the audio server. Try again in a moment.');
    }
    this.player = player;
    this.channelId = channelId;
    this.leaving = false;
    bindPlayerEvents(player, this);
    if (this.queue.volume !== player.volume) {
      await player.setGlobalVolume(this.queue.volume).catch((error) => {
        console.error(`[player:${this.guildId}] volume failed: ${error.message}`);
      });
    }
    return player;
  }

  async playCurrent(generation, options = {}) {
    const skipped = [];
    let failures = 0;
    while (this.queue.current && failures < MAX_CONSECUTIVE_FAILURES) {
      if (generation !== this.generation || this.leaving) return { dropped: true, skipped };
      const track = this.queue.current;
      let identifier;
      try {
        identifier = await this.manager.providers.playbackIdentifier(track);
      } catch (error) {
        log('error', 'playback failed', {
          guildId: this.guildId,
          source: track.source,
          error: error.message,
          node: this.manager.lavalink?.getIdealNode?.()?.name,
        });
        failures += 1;
        skipped.push({ title: track.title, reason: this.reasonFor(error, track.source) });
        this.dropCurrent();
        continue;
      }
      if (generation !== this.generation || this.leaving) return { dropped: true, skipped };
      if (!this.player) {
        return { ok: false, reason: 'I am not connected to voice.', track, skipped };
      }
      let response;
      try {
        response = await this.node().rest.resolve(identifier);
      } catch (error) {
        log('error', 'playback failed', {
          guildId: this.guildId,
          source: track.source,
          error: error.message,
          node: this.manager.lavalink?.getIdealNode?.()?.name,
        });
        this.queue.current = null;
        this.queue.upcoming.unshift(track);
        return { ok: false, reason: 'The audio server could not load that track.', skipped };
      }
      if (!response || response.loadType !== 'track') {
        if (response?.loadType === 'error') {
          log('error', 'playback failed', {
            guildId: this.guildId,
            source: track.source,
            error: response.data?.message || 'unknown',
            node: this.manager.lavalink?.getIdealNode?.()?.name,
          });
        }
        failures += 1;
        skipped.push({ title: track.title, reason: 'that audio is unavailable' });
        this.dropCurrent();
        continue;
      }
      try {
        this.starting = true;
        this.playGeneration = generation;
        this.paused = false;
        this.pendingSeekMs = !skipped.length && options.seekMs > 0 ? Math.floor(options.seekMs) : 0;
        await this.player.playTrack({
          track: { encoded: response.data.encoded },
          volume: this.queue.volume,
        });
        await this.restorePlaybackOptions(options, skipped);
        return { ok: true, track, skipped };
      } catch (error) {
        this.playGeneration = -1;
        log('error', 'playback failed', {
          guildId: this.guildId,
          source: track.source,
          error: error.message,
          node: this.manager.lavalink?.getIdealNode?.()?.name,
        });
        failures += 1;
        skipped.push({ title: track.title, reason: 'The audio server could not start playback.' });
        this.dropCurrent();
      } finally {
        this.starting = false;
      }
    }
    if (generation !== this.generation || this.leaving) return { dropped: true, skipped };
    if (this.queue.current) {
      this.queue.upcoming.unshift(this.queue.current);
      this.queue.current = null;
      return { ok: false, reason: 'Several tracks failed in a row, so playback stopped.', skipped };
    }
    if (skipped.length) return { ok: false, reason: skipped.at(-1).reason, skipped };
    return { ok: true, empty: true, skipped };
  }

  dropCurrent() {
    this.queue.rememberCurrent = false;
    this.queue.shiftNext();
  }

  reasonFor(error, source) {
    if (error?.userError) return error.message;
    const provider = this.manager.providers.get(source);
    if (provider?.friendly) return provider.friendly(error);
    return 'that track is unavailable';
  }

  async add(tracks, { now = false } = {}) {
    return this.enqueue(async () => {
      if (this.leaving) return { dropped: true };
      const placed = now ? this.queue.placeNow(tracks) : this.queue.enqueue(tracks);
      if (!placed.accepted.length) {
        throw new UserError(`The queue is full (${MAX_QUEUE} tracks). Skip or stop before adding more.`);
      }
      const idle = !this.queue.current;
      if (!now && !idle) {
        return {
          ...placed,
          started: false,
          position: this.queue.upcoming.length - placed.accepted.length + 1,
          outcome: { ok: true, skipped: [] },
        };
      }
      this.generation += 1;
      this.playGeneration = -1;
      if (now && this.player) {
        try {
          await this.player.stopTrack();
        } catch (error) {
          console.error(`[player:${this.guildId}] stop before play now failed: ${error.message}`);
        }
      }
      this.queue.shiftNext();
      const outcome = await this.playCurrent(this.generation);
      return { ...placed, started: true, position: 1, outcome };
    });
  }

  async skip() {
    return this.enqueue(async () => {
      if (!this.queue.current && this.queue.upcoming.length === 0) {
        throw new UserError('Nothing is playing right now.');
      }
      this.generation += 1;
      this.playGeneration = -1;
      if (this.player) {
        try {
          await this.player.stopTrack();
        } catch (error) {
          console.error(`[player:${this.guildId}] skip failed: ${error.message}`);
        }
      }
      const skipped = this.queue.current;
      this.queue.shiftNext();
      const outcome = await this.playCurrent(this.generation);
      return { skipped, outcome };
    });
  }

  async previous() {
    return this.enqueue(async () => {
      if (!this.queue.history.length) throw new UserError('There is no previous track.');
      this.queue.previous();
      this.generation += 1;
      this.playGeneration = -1;
      if (this.player) {
        try {
          await this.player.stopTrack();
        } catch (error) {
          console.error(`[player:${this.guildId}] previous failed: ${error.message}`);
        }
      }
      this.queue.shiftNext();
      return this.playCurrent(this.generation);
    });
  }

  async pause() {
    return this.enqueue(async () => {
      if (!this.queue.current || !this.player) throw new UserError('Nothing is playing right now.');
      await this.player.setPaused(true);
      this.paused = true;
      return 'Paused.';
    });
  }

  async resumePlayback() {
    return this.enqueue(async () => {
      if (!this.queue.current || !this.player) throw new UserError('Nothing is playing right now.');
      await this.player.setPaused(false);
      this.paused = false;
      return 'Resumed.';
    });
  }

  async setVolume(value) {
    return this.enqueue(async () => {
      if (!Number.isInteger(value) || value < 0 || value > 150) {
        throw new UserError('Volume must be a whole number from 0 to 150.');
      }
      this.queue.volume = value;
      this.manager.database.setVolume(this.guildId, value);
      if (this.player) await this.player.setGlobalVolume(value);
      return `Volume set to ${value}.`;
    });
  }

  clearUpcoming() {
    const count = this.queue.clearUpcoming();
    this.persist();
    return count;
  }

  async stop() {
    return this.enqueue(() => this.disconnectQueued('Stopped playback and cleared the queue.'));
  }

  async leave() {
    return this.enqueue(() => this.disconnectQueued('Left the voice channel and cleared the queue.'));
  }

  async disconnectQueued(text) {
    this.leaving = true;
    this.generation += 1;
    this.playGeneration = -1;
    this.queue.reset();
    this.paused = false;
    this.positionMs = 0;
    const player = this.player;
    this.player = null;
    this.channelId = null;
    try {
      await player?.stopTrack();
    } catch (error) {
      console.error(`[player:${this.guildId}] stop failed: ${error.message}`);
    }
    try {
      await this.manager.lavalink.leaveVoiceChannel(this.guildId);
    } catch (error) {
      console.error(`[player:${this.guildId}] leave failed: ${error.message}`);
    }
    this.leaving = false;
    return text;
  }

  async shutdown() {
    return this.enqueue(async () => {
      this.skipPersist = true;
      this.persist();
      this.leaving = true;
      this.generation += 1;
      this.playGeneration = -1;
      try {
        await this.player?.stopTrack();
      } catch (error) {
        console.error(`[player:${this.guildId}] shutdown stop failed: ${error.message}`);
      }
      try {
        await this.manager.lavalink.leaveVoiceChannel(this.guildId);
      } catch (error) {
        console.error(`[player:${this.guildId}] shutdown leave failed: ${error.message}`);
      }
      this.player = null;
      this.channelId = null;
    });
  }

  async advanceAfter(reason) {
    const failed = reason === 'loadFailed' ? this.queue.current : null;
    if (reason === 'finished' && this.queue.loopMode === 'track' && this.queue.current && !failed) {
      this.generation += 1;
      const outcome = await this.playCurrent(this.generation);
      const notes = outcome.ok === false ? [outcome.reason] : [];
      await this.refreshPanel(notes.filter(Boolean).join('\n') || null);
      return;
    }
    if (reason === 'finished' && this.queue.loopMode === 'queue' && this.queue.current) {
      this.queue.upcoming.push(this.queue.current);
      this.queue.rememberCurrent = false;
    }
    if (failed) {
      log('error', 'playback failed', {
        guildId: this.guildId,
        source: failed.source,
        error: 'loadFailed',
        node: this.manager.lavalink?.getIdealNode?.()?.name,
      });
    }
    this.queue.shiftNext();
    const outcome = await this.playCurrent(this.generation);
    const notes = [];
    if (failed) notes.push(`Couldn't play **${this.displayTitle(failed)}**: that audio is unavailable.`);
    notes.push(...this.skippedNotes(outcome));
    if (!this.queue.current) notes.push('The queue has finished.');
    await this.refreshPanel(notes.filter(Boolean).join('\n') || null);
  }

  async seek(positionMs) {
    return this.enqueue(async () => {
      if (!this.queue.current || !this.player) throw new UserError('Nothing is playing right now.');
      if (!Number.isFinite(positionMs) || positionMs < 0) throw new UserError('Use seconds or a timestamp like 1:30.');
      try {
        await this.player.seekTo(Math.floor(positionMs));
      } catch (error) {
        log('error', 'playback failed', {
          guildId: this.guildId,
          source: this.queue.current?.source,
          error: error.message,
          node: this.manager.lavalink?.getIdealNode?.()?.name,
        });
        throw new UserError('That track cannot be seeked.');
      }
      this.positionMs = Math.floor(positionMs);
      return `Moved to ${formatClock(this.positionMs)}.`;
    });
  }

  async setLoop(mode) {
    return this.enqueue(async () => {
      if (!['off', 'track', 'queue'].includes(mode)) throw new UserError('Loop must be off, track, or queue.');
      this.queue.loopMode = mode;
      const labels = { off: 'Looping is off.', track: 'Looping this track.', queue: 'Looping the queue.' };
      return labels[mode];
    });
  }

  async shuffleUpcoming() {
    return this.enqueue(async () => {
      const count = this.queue.shuffle();
      if (count < 2) throw new UserError('Add at least two songs to the queue before shuffling.');
      return `Shuffled ${count} songs.`;
    });
  }

  async removeUpcoming(index) {
    return this.enqueue(async () => {
      const track = this.queue.removeAt(index);
      if (!track) throw new UserError('That queue number is not in the list.');
      return `Removed **${oneLine(track.title)}**.`;
    });
  }

  async moveUpcoming(from, to) {
    return this.enqueue(async () => {
      const track = this.queue.move(from, to);
      if (!track) throw new UserError('Those queue numbers are not in the list.');
      return `Moved **${oneLine(track.title)}** to position ${to}.`;
    });
  }

  async restorePlaybackOptions(options, skipped) {
    try {
      if (!skipped.length && options.seekMs > 0 && this.player?.seekTo) {
        await this.player.seekTo(Math.floor(options.seekMs));
        this.positionMs = Math.floor(options.seekMs);
      }
      if (this.filter && this.filter !== 'off' && this.player?.clearFilters) {
        await this.applyFilter(this.filter);
      }
      if (!skipped.length && options.pauseAfter && this.player?.setPaused) {
        await this.player.setPaused(true);
        this.paused = true;
      }
    } catch (error) {
      log('error', 'playback option failed', {
        guildId: this.guildId,
        source: this.queue.current?.source,
        error: error.message,
        node: this.manager.lavalink?.getIdealNode?.()?.name,
      });
    }
  }

  async applyFilter(name) {
    if (!this.player?.clearFilters) return;
    await this.player.clearFilters();
    if (name === 'bassboost') {
      await this.player.setEqualizer([
        { band: 0, gain: 0.2 },
        { band: 1, gain: 0.15 },
        { band: 2, gain: 0.1 },
        { band: 3, gain: 0.05 },
        { band: 4, gain: 0.0 },
      ]);
    } else if (name === 'nightcore') {
      await this.player.setTimescale({ speed: 1.2, pitch: 1.2, rate: 1 });
    }
    if (this.player.setGlobalVolume) await this.player.setGlobalVolume(this.queue.volume);
    this.filter = name;
  }

  async setFilter(name) {
    return this.enqueue(async () => {
      if (!this.player) throw new UserError('Nothing is playing right now.');
      if (!['off', 'bassboost', 'nightcore'].includes(name)) {
        throw new UserError('Filters are bassboost, nightcore, or off.');
      }
      await this.applyFilter(name);
      return name === 'off' ? 'Filters cleared.' : `Filter set to ${name}.`;
    });
  }

  voiceChannelEmpty() {
    const guild = this.manager.client?.guilds?.cache?.get(this.guildId);
    const channel = guild?.channels?.cache?.get(this.channelId);
    if (!channel?.members) return null;
    let humans = 0;
    for (const member of channel.members.values()) {
      if (!member.user?.bot) humans += 1;
    }
    return humans === 0;
  }

  isIdle() {
    const queueIdle = !this.queue.current && this.queue.upcoming.length === 0;
    const empty = this.voiceChannelEmpty();
    if (empty === null) return queueIdle;
    return empty || queueIdle;
  }

  async refreshPanel(extra) {
    if (!this.panel) return;
    try {
      const channel = await this.manager.client.channels.fetch(this.panel.channelId);
      if (!channel?.messages?.fetch) return;
      const message = await channel.messages.fetch(this.panel.messageId);
      await message.edit(playerMessage(this, extra));
    } catch (error) {
      if (!this.panelErrorLogged) {
        console.error(`[panel] ${error.message}`);
        this.panelErrorLogged = true;
      }
    }
  }
}

function formatClock(positionMs) {
  const total = Math.floor(positionMs / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function clampVolume(value) {
  return Math.min(150, Math.max(0, value));
}

module.exports = { GuildSession, MAX_QUEUE };
