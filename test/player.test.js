const test = require('node:test');
const assert = require('node:assert/strict');
const { GuildSession } = require('../src/music/player');
const { GuildQueue } = require('../src/music/queue');
const { createTrack } = require('../src/music/track');

function session() {
  const player = {
    played: [],
    async playTrack(options) {
      this.played.push(options.track.encoded);
    },
  };
  const guild = Object.create(GuildSession.prototype);
  guild.guildId = 'guild-a';
  guild.queue = new GuildQueue('guild-a');
  guild.generation = 1;
  guild.leaving = false;
  guild.starting = false;
  guild.playGeneration = -1;
  guild.paused = false;
  guild.player = player;
  guild.manager = {
    providers: {
      async playbackIdentifier(track) {
        if (track.title === 'Broken') {
          const error = new Error('That file is no longer in the local music library.');
          error.userError = true;
          throw error;
        }
        return track.title;
      },
      get() {
        return null;
      },
    },
    lavalink: {
      getIdealNode() {
        return {
          rest: {
            async resolve(identifier) {
              if (identifier === 'Missing') return { loadType: 'empty' };
              return { loadType: 'track', data: { encoded: identifier } };
            },
          },
        };
      },
    },
  };
  return guild;
}

test('a missing track is skipped and the next server queue entry plays', async () => {
  const guild = session();
  guild.queue.current = createTrack({ title: 'Missing', artist: 'A', source: 'local' });
  guild.queue.upcoming = [createTrack({ title: 'Ready', artist: 'A', source: 'local' })];
  const outcome = await guild.playCurrent(1);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.track.title, 'Ready');
  assert.equal(outcome.skipped.length, 1);
  assert.deepEqual(guild.player.played, ['Ready']);
});

test('a failed track does not stay stuck as the current song', async () => {
  const guild = session();
  guild.queue.current = createTrack({ title: 'Broken', artist: 'A', source: 'local' });
  const outcome = await guild.playCurrent(1);
  assert.equal(outcome.ok, false);
  assert.equal(guild.queue.current, null);
  assert.equal(guild.player.played.length, 0);
});

test('an encoded youtube track plays without loading the watch page again', async () => {
  const guild = session();
  let resolved = false;
  guild.manager.lavalink.getIdealNode = () => ({
    rest: {
      async resolve() {
        resolved = true;
        return { loadType: 'empty' };
      },
    },
  });
  guild.queue.current = createTrack({
    title: 'Haroun',
    artist: 'El Rass',
    source: 'youtube',
    identifier: 'https://www.youtube.com/watch?v=abc',
    encoded: 'encoded-track',
  });
  const outcome = await guild.playCurrent(1);
  assert.equal(outcome.ok, true);
  assert.equal(resolved, false);
  assert.deepEqual(guild.player.played, ['encoded-track']);
});

test('two server sessions keep their own players and queues', async () => {
  const first = session();
  const second = session();
  second.guildId = 'guild-b';
  second.queue = new GuildQueue('guild-b');
  first.queue.enqueue([createTrack({ title: 'One', artist: 'A', source: 'local' })]);
  second.queue.enqueue([createTrack({ title: 'Two', artist: 'B', source: 'local' })]);
  first.queue.shiftNext();
  second.queue.shiftNext();
  await first.playCurrent(1);
  await second.playCurrent(1);
  assert.deepEqual(first.player.played, ['One']);
  assert.deepEqual(second.player.played, ['Two']);
  assert.equal(first.queue.current.title, 'One');
  assert.equal(second.queue.current.title, 'Two');
});
