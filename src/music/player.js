const { UserError } = require('../errors');
const { oneLine } = require('../format');
const { bindPlayerEvents } = require('../lavalink/events');
const { playerMessage } = require('../panel');
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
    const next = this.tail.then(task, task);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
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

  async playCurrent(generation) {
    const skipped = [];
    let failures = 0;
    while (this.queue.current && failures < MAX_CONSECUTIVE_FAILURES) {
      if (generation !== this.generation || this.leaving) return { dropped: true, skipped };
      const track = this.queue.current;
      let identifier;
      try {
        identifier = await this.manager.providers.playbackIdentifier(track);
      } catch (error) {
        console.error(`[provider:${track.source}] playback failed: ${error.message}`);
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
        console.error(`[lavalink] resolve failed: ${error.message}`);
        this.queue.current = null;
        this.queue.upcoming.unshift(track);
        return { ok: false, reason: 'The audio server could not load that track.', skipped };
      }
      if (!response || response.loadType !== 'track') {
        if (response?.loadType === 'error') {
          console.error(`[lavalink] load error: ${response.data?.message || 'unknown'}`);
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
        await this.player.playTrack({
          track: { encoded: response.data.encoded },
          volume: this.queue.volume,
        });
        return { ok: true, track, skipped };
      } catch (error) {
        this.playGeneration = -1;
        console.error(`[lavalink] play failed: ${error.message}`);
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
    return this.queue.clearUpcoming();
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

function clampVolume(value) {
  return Math.min(150, Math.max(0, value));
}

module.exports = { GuildSession, MAX_QUEUE };
