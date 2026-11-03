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
    this.loopMode = 'off';
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

  removeAt(index) {
    if (!Number.isInteger(index) || index < 1 || index > this.upcoming.length) return null;
    return this.upcoming.splice(index - 1, 1)[0];
  }

  move(from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
    if (from < 1 || to < 1 || from > this.upcoming.length || to > this.upcoming.length) return null;
    const [track] = this.upcoming.splice(from - 1, 1);
    this.upcoming.splice(to - 1, 0, track);
    return track;
  }

  shuffle() {
    for (let index = this.upcoming.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      const current = this.upcoming[index];
      this.upcoming[index] = this.upcoming[swap];
      this.upcoming[swap] = current;
    }
    return this.upcoming.length;
  }

  reset() {
    this.upcoming = [];
    this.history = [];
    this.current = null;
    this.loopMode = 'off';
    this.rememberCurrent = true;
  }
}

module.exports = { GuildQueue, MAX_QUEUE, MAX_HISTORY };
