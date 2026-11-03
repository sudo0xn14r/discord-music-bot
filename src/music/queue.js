const MAX_QUEUE = 50;
const MAX_HISTORY = 25;

class GuildQueue {
  constructor(guildId) {
    this.guildId = guildId;
    this.upcoming = [];
    this.history = [];
    this.current = null;
    this.textChannelId = null;
    this.volume = 100;
    this.rememberCurrent = true;
  }

  freeSlots() {
    return Math.max(0, MAX_QUEUE - this.upcoming.length);
  }

  enqueue(tracks) {
    const room = this.freeSlots();
    const accepted = tracks.slice(0, room);
    this.upcoming.push(...accepted);
    return {
      accepted,
      skipped: tracks.length - accepted.length,
    };
  }

  placeNow(tracks) {
    const accepted = tracks.slice(0, MAX_QUEUE);
    const kept = Math.max(0, MAX_QUEUE - accepted.length);
    this.upcoming = [...accepted, ...this.upcoming.slice(0, kept)];
    return {
      accepted,
      skipped: tracks.length - accepted.length,
    };
  }

  shiftNext() {
    const track = this.upcoming.shift() || null;
    if (this.current && this.rememberCurrent) {
      this.history.push(this.current);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
    this.rememberCurrent = true;
    this.current = track;
    return track;
  }

  previous() {
    if (!this.history.length) return null;
    const prior = this.history.pop();
    if (this.current) this.upcoming.unshift(this.current);
    this.upcoming.unshift(prior);
    if (this.upcoming.length > MAX_QUEUE) this.upcoming.length = MAX_QUEUE;
    this.rememberCurrent = false;
    return prior;
  }

  clearUpcoming() {
    const count = this.upcoming.length;
    this.upcoming = [];
    return count;
  }

  reset() {
    this.upcoming = [];
    this.history = [];
    this.current = null;
    this.rememberCurrent = true;
  }
}

module.exports = { GuildQueue, MAX_QUEUE, MAX_HISTORY };
