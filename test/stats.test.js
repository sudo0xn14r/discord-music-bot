const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { MusicManager } = require('../src/music/manager');
const { GuildSession } = require('../src/music/player');
const { createTrack } = require('../src/music/track');

test('play stats rank songs and listeners and sum listening time', () => {
  const database = openDatabase(':memory:');
  const haroun = createTrack({
    title: 'Haroun',
    artist: 'El Rass',
    source: 'youtube',
    requester: 'Nizar',
    requesterId: '100000000000000001',
    durationMs: 180000,
  });
  const other = createTrack({
    title: 'Other Song',
    artist: 'Someone',
    source: 'youtube',
    requester: 'Sam',
    requesterId: '100000000000000002',
    durationMs: 60000,
  });
  const first = database.beginListen('guild-a', haroun);
  database.touchListen(first, 180000);
  const second = database.beginListen('guild-a', { ...haroun, title: 'haroun' });
  database.touchListen(second, 90000);
  const third = database.beginListen('guild-a', other);
  database.touchListen(third, 30000);
  database.beginListen('guild-b', other);

  const report = database.playStats('guild-a', 5);
  assert.equal(report.plays, 3);
  assert.equal(report.playedMs, 300000);
  assert.equal(report.songs[0].title, 'haroun');
  assert.equal(report.songs[0].plays, 2);
  assert.equal(report.songs[0].playedMs, 270000);
  assert.equal(report.songs[1].plays, 1);
  assert.equal(report.users[0].requesterName, 'Nizar');
  assert.equal(report.users[0].plays, 2);
  assert.equal(report.users[0].playedMs, 270000);
  assert.equal(report.users[1].requesterName, 'Sam');
  database.close();
});

test('an empty queue leaves after ten minutes and a playing queue stays', async () => {
  const notices = [];
  const manager = new MusicManager({
    database: openDatabase(':memory:'),
    client: {
      channels: {
        async fetch() {
          return {
            isTextBased: () => true,
            async send(payload) {
              notices.push(payload.content);
            },
          };
        },
      },
    },
    config: { idleMinutes: 10 },
  });
  const idle = new GuildSession(manager, 'guild-a');
  idle.channelId = 'voice';
  idle.queue.textChannelId = 'text';
  idle.idleSince = Date.now() - (10 * 60 * 1000) - 1;
  idle.leave = async () => {
    idle.channelId = null;
  };
  const playing = new GuildSession(manager, 'guild-b');
  playing.channelId = 'voice';
  playing.queue.current = createTrack({ title: 'Haroun', artist: 'El Rass', source: 'youtube' });
  playing.idleSince = Date.now() - (60 * 60 * 1000);
  playing.leave = async () => {
    throw new Error('should not leave');
  };
  manager.sessions.set(idle.guildId, idle);
  manager.sessions.set(playing.guildId, playing);

  await manager.checkIdle();

  assert.equal(idle.channelId, null);
  assert.equal(playing.channelId, 'voice');
  assert.equal(playing.idleSince, null);
  assert.deepEqual(notices, ['I left the voice channel after 10 minutes with nothing playing.']);
});

test('a finished track records its full length and a skip records the position reached', () => {
  const database = openDatabase(':memory:');
  const guild = Object.create(GuildSession.prototype);
  guild.guildId = 'guild-a';
  guild.positionMs = 0;
  guild.listenId = null;
  guild.listenMaxMs = 0;
  guild.listenStartMs = 0;
  guild.listenDurationMs = null;
  guild.manager = { database };
  guild.beginListen(createTrack({
    title: 'Haroun',
    artist: 'El Rass',
    source: 'youtube',
    requester: 'Nizar',
    requesterId: '100000000000000001',
    durationMs: 180000,
  }));
  guild.positionMs = 180000;
  guild.finishListen({ completed: true });
  guild.positionMs = 0;
  guild.beginListen(createTrack({
    title: 'Other Song',
    artist: 'Someone',
    source: 'local',
    requester: 'Sam',
    requesterId: '100000000000000002',
    durationMs: 60000,
  }));
  guild.positionMs = 12000;
  guild.listenMaxMs = 12000;
  guild.finishListen();
  const report = database.playStats('guild-a', 5);
  assert.equal(report.plays, 2);
  assert.equal(report.playedMs, 192000);
  assert.equal(report.songs[0].playedMs, 180000);
  assert.equal(report.songs[1].playedMs, 12000);
  database.close();
});
