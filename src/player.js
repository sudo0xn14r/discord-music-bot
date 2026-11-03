const {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
  joinVoiceChannel,
} = require('@discordjs/voice');
const { UserError } = require('./errors');
const { formatDuration, oneLine, shortError } = require('./format');
const { ensurePlayable, friendlyYtError, openAudioStream } = require('./media');
const { playerMessage } = require('./panel');

const MAX_QUEUE = 50;
const MAX_HISTORY = 25;
const MAX_FAILURES = 3;

class GuildSession {
  constructor(guildId, manager) {
    this.guildId = guildId;
    this.manager = manager;
    this.tracks = [];
    this.history = [];
    this.current = null;
    this.rememberCurrent = true;
    this.panelRef = null;
    this.connection = null;
    this.textChannelId = null;
    this.process = null;
    this.generation = 0;
    this.suppressAutoplay = false;
    this.intentionalLeave = false;
    this.playbackError = null;
    this.consecutiveFailures = 0;
    this.playLock = false;
    this.advanceAfterLock = false;
    this.advanceAnnounce = true;
    this.startFailure = null;
    this.player = createAudioPlayer();

    this.player.on('error', (error) => {
      this.playbackError = error;
      console.error(`Playback error in ${this.guildId}: ${error.message}`);
    });

    this.player.on(AudioPlayerStatus.Playing, () => {
      this.consecutiveFailures = 0;
    });

    this.player.on('stateChange', (oldState, newState) => {
      console.log(`Player ${oldState.status} -> ${newState.status} in ${this.guildId}.`);
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      const error = this.playbackError;
      this.playbackError = null;
      if (this.suppressAutoplay) return;
      if (this.playLock) {
        this.startFailure = error;
        this.advanceAfterLock = true;
        this.advanceAnnounce = true;
        return;
      }
      const failed = error ? this.current : null;
      if (failed) {
        void this.announce(`Couldn't play **${oneLine(failed.title)}**: ${shortError(error)}`);
      }
      void this.playNext({ announce: true });
    });
  }

  get channelId() {
    if (!this.connection || this.connection.state.status === VoiceConnectionStatus.Destroyed) {
      return null;
    }
    return this.connection.joinConfig.channelId;
  }

  bindTextChannel(channelId) {
    this.textChannelId = channelId;
  }

  async join(channel) {
    if (this.channelId === channel.id) return;
    if (this.channelId) {
      throw new UserError('You need to be in the same voice channel as me.');
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    this.connection = connection;
    connection.on('error', (error) => {
      console.error(`Voice connection error in ${this.guildId}: ${error.message}`);
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
      console.error(`Voice join failed in ${this.guildId}: ${error.message}`);
      this.connection = null;
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      throw new UserError("I couldn't join your voice channel. I need Connect and Speak permission there.");
    }

    connection.subscribe(this.player);
    connection.on('stateChange', (oldState, newState) => {
      console.log(`Voice ${oldState.status} -> ${newState.status} in ${this.guildId}.`);
    });
    this.watchConnection(connection);
  }

  watchConnection(connection) {
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (this.connection !== connection) return;
      const intentional = this.intentionalLeave;
      this.connection = null;
      this.stopPlayback();
      if (!intentional) void this.announce('I was disconnected from voice.');
      this.manager.forget(this.guildId);
    });
  }

  freeSlots() {
    return Math.max(0, MAX_QUEUE - this.tracks.length);
  }

  enqueueAll(tracks) {
    if (!tracks.length) throw new UserError("I couldn't find anything to play.");
    const room = this.freeSlots();
    if (room <= 0) {
      throw new UserError(`The queue is full (${MAX_QUEUE} tracks). Skip or stop before adding more.`);
    }
    const accepted = tracks.slice(0, room);
    const startNow = !this.current && this.player.state.status === AudioPlayerStatus.Idle;
    for (const track of accepted) this.tracks.push(track);
    const playback = startNow ? this.playNext({ announce: false }) : null;
    return {
      started: startNow,
      added: accepted.length,
      skipped: tracks.length - accepted.length,
      first: accepted[0],
      position: startNow ? 0 : this.tracks.length - accepted.length + 1,
      playback,
    };
  }

  async playNext({ announce }) {
    if (this.playLock) {
      this.advanceAfterLock = true;
      this.advanceAnnounce = announce;
      return;
    }
    this.playLock = true;
    let outcome = { ok: false, reason: 'Playback did not start.' };
    try {
      outcome = await this.startTrack({ announce });
    } finally {
      this.playLock = false;
      if (this.advanceAfterLock) {
        const nextAnnounce = this.advanceAnnounce;
        this.advanceAfterLock = false;
        await this.playNext({ announce: nextAnnounce });
      }
    }
    return outcome;
  }

  async startTrack({ announce }) {
    const generation = ++this.generation;
    this.killProcess();
    const track = this.tracks.shift() || null;
    if (this.current && this.rememberCurrent) {
      this.history.push(this.current);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
    this.rememberCurrent = true;
    this.current = track;
    if (!track) {
      void this.refreshPanel();
      return { ok: true };
    }

    let opened;
    try {
      await ensurePlayable(track);
      if (generation !== this.generation) return { ok: false, dropped: true };
      console.log(`Opening audio for ${track.url}`);
      opened = openAudioStream(track.url);
      this.process = opened.process;
      const probed = await demuxProbe(opened.stream);
      opened.clearStartTimeout();
      if (generation !== this.generation) {
        opened.kill();
        return { ok: false, dropped: true };
      }
      console.log(`Probed ${track.url} as ${probed.type}.`);
      if (probed.type !== 'ogg/opus') {
        const detail = opened.stderr().trim();
        throw new Error(detail || 'That audio could not be converted for Discord.');
      }
      const resource = createAudioResource(probed.stream, { inputType: probed.type });
      this.process = opened.process;
      opened.process.once('close', () => {
        if (this.process === opened.process) this.process = null;
      });
      this.player.play(resource);
      await entersState(this.player, AudioPlayerStatus.Playing, 20_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (generation !== this.generation) return { ok: false, dropped: true };
      if (this.player.state.status !== AudioPlayerStatus.Playing) {
        const detail = opened.stderr().trim();
        throw new Error(detail || 'The audio stream ended before any sound was sent.');
      }
      console.log(`Audio started for ${track.url}.`);
      void this.refreshPanel();
      if (announce) {
        const via = track.source === 'spotify' || track.source === 'deezer' || track.source === 'apple'
          ? ' (YouTube match)'
          : '';
        await this.announce(`Now playing **${oneLine(track.title)}** (${formatDuration(track.duration)})${via}.`);
      }
      return { ok: true };
    } catch (error) {
      opened?.kill();
      if (this.player.state.status !== AudioPlayerStatus.Idle) {
        this.suppressAutoplay = true;
        this.player.stop(true);
        this.suppressAutoplay = false;
      }
      if (generation !== this.generation) return { ok: false, dropped: true };
      this.consecutiveFailures += 1;
      const stderr = opened?.stderr() || '';
      const detail = stderr ? friendlyYtError(stderr, null) : '';
      const reason = detail && !/^Couldn't open that \(yt-dlp/.test(detail) ? detail : shortError(error);
      console.error(`Failed to start ${track.url}: ${reason}`);
      if (stderr.trim()) console.error(stderr.trim());
      await this.announce(`Couldn't play **${oneLine(track.title)}**: ${reason}`);
      this.current = null;
      if (this.consecutiveFailures >= MAX_FAILURES) {
        this.tracks = [];
        this.advanceAfterLock = false;
        await this.announce(`Stopped after ${MAX_FAILURES} playback failures in a row.`);
        return { ok: false, reason };
      }
      this.advanceAfterLock = true;
      this.advanceAnnounce = true;
      return { ok: false, reason };
    }
  }

  pause() {
    this.assertControllable();
    const status = this.player.state.status;
    if (status === AudioPlayerStatus.Paused) {
      throw new UserError('Playback is already paused.');
    }
    if (status === AudioPlayerStatus.Playing) {
      this.player.pause(true);
      return 'Paused.';
    }
    if (status === AudioPlayerStatus.AutoPaused) {
      throw new UserError('The voice connection dropped. Playback should resume on its own.');
    }
    if (status === AudioPlayerStatus.Buffering || this.current) {
      throw new UserError('The track is still starting. Try again in a moment.');
    }
    throw new UserError('Nothing is playing right now.');
  }

  resume() {
    this.assertControllable();
    const status = this.player.state.status;
    if (status === AudioPlayerStatus.Paused) {
      this.player.unpause();
      return 'Resumed.';
    }
    if (status === AudioPlayerStatus.Playing) {
      throw new UserError("Playback isn't paused.");
    }
    if (status === AudioPlayerStatus.AutoPaused) {
      throw new UserError('The voice connection dropped. Playback should resume on its own.');
    }
    if (status === AudioPlayerStatus.Buffering || this.current) {
      throw new UserError('The track is still starting. Try again in a moment.');
    }
    throw new UserError('Nothing is playing right now.');
  }

  skip() {
    this.assertControllable();
    if (!this.current) throw new UserError('Nothing is playing right now.');
    const title = oneLine(this.current.title);
    return { text: `Skipped **${title}**.`, playback: this.restart() };
  }

  async previous() {
    this.assertControllable();
    if (!this.history.length) throw new UserError('Nothing to go back to.');
    const prior = this.history.pop();
    if (this.current) this.tracks.unshift(this.current);
    this.tracks.unshift(prior);
    if (this.tracks.length > MAX_QUEUE) this.tracks.length = MAX_QUEUE;
    this.rememberCurrent = false;
    const playback = this.restart();
    const outcome = await playback;
    return outcome || { ok: false, reason: 'Playback did not start.' };
  }

  playNow(tracks) {
    if (!tracks.length) throw new UserError("I couldn't find anything to play.");
    const accepted = tracks.slice(0, MAX_QUEUE);
    const kept = Math.max(0, MAX_QUEUE - accepted.length);
    this.tracks = [...accepted, ...this.tracks.slice(0, kept)];
    return {
      first: accepted[0],
      added: accepted.length,
      skipped: tracks.length - accepted.length,
      playback: this.restart(),
    };
  }

  clearUpcoming() {
    this.assertControllable();
    const count = this.tracks.length;
    this.tracks = [];
    return count;
  }

  restart() {
    this.suppressAutoplay = true;
    this.advanceAfterLock = false;
    this.generation += 1;
    this.killProcess();
    if (this.player.state.status !== AudioPlayerStatus.Idle) this.player.stop(true);
    this.suppressAutoplay = false;
    return this.playNext({ announce: false });
  }

  notePanel(message) {
    if (!message?.id || !message.channelId) return;
    this.panelRef = { channelId: message.channelId, messageId: message.id };
  }

  async refreshPanel(extra) {
    if (!this.panelRef) return;
    try {
      const channel = await this.manager.client.channels.fetch(this.panelRef.channelId);
      if (!channel?.isTextBased?.()) return;
      const message = await channel.messages.fetch(this.panelRef.messageId);
      const payload = this.current || this.tracks.length
        ? playerMessage(this, extra)
        : { content: extra || 'Nothing is playing.', components: [], allowedMentions: { parse: [] } };
      await message.edit(payload);
    } catch (error) {
      if (error.code === 10008) this.panelRef = null;
      else console.error(`Could not update the player: ${error.message}`);
    }
  }

  stop() {
    this.assertControllable();
    if (!this.current && this.tracks.length === 0) {
      throw new UserError('Nothing is playing right now.');
    }
    this.stopPlayback();
    void this.refreshPanel('Stopped playback and cleared the queue.');
    return 'Stopped playback and cleared the queue.';
  }

  leave() {
    if (!this.channelId) throw new UserError("I'm not in a voice channel.");
    this.intentionalLeave = true;
    this.connection.destroy();
    return 'Left the voice channel and cleared the queue.';
  }

  assertControllable() {
    if (!this.channelId) throw new UserError("I'm not in a voice channel.");
  }

  stopPlayback() {
    this.suppressAutoplay = true;
    this.advanceAfterLock = false;
    this.generation += 1;
    this.killProcess();
    this.tracks = [];
    this.history = [];
    this.current = null;
    this.rememberCurrent = true;
    this.playbackError = null;
    this.consecutiveFailures = 0;
    this.player.stop(true);
    this.suppressAutoplay = false;
  }

  killProcess() {
    if (!this.process) return;
    if (this.process.exitCode == null && !this.process.killed) {
      this.process.kill('SIGKILL');
    }
    this.process = null;
  }

  async announce(text) {
    if (!this.textChannelId) return;
    try {
      const channel = await this.manager.client.channels.fetch(this.textChannelId);
      if (!channel || !channel.isTextBased()) return;
      await channel.send({ content: text, allowedMentions: { parse: [] } });
    } catch (error) {
      console.error(`Could not send a playback message: ${error.message}`);
    }
  }
}

class Player {
  constructor(client) {
    this.client = client;
    this.sessions = new Map();
  }

  peek(guildId) {
    return this.sessions.get(guildId) || null;
  }

  session(guildId) {
    let existing = this.sessions.get(guildId);
    if (!existing) {
      existing = new GuildSession(guildId, this);
      this.sessions.set(guildId, existing);
    }
    return existing;
  }

  forget(guildId) {
    this.sessions.delete(guildId);
  }

  shutdown() {
    for (const session of this.sessions.values()) {
      session.intentionalLeave = true;
      try {
        session.connection?.destroy();
      } catch (error) {
        console.error(`Voice shutdown error: ${error.message}`);
      }
    }
  }
}

module.exports = { Player, MAX_QUEUE };
