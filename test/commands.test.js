const test = require('node:test');
const assert = require('node:assert/strict');
const { commands, sendPlayGif } = require('../src/commands');
const { playerMessage } = require('../src/panel');

test('/k2 starts playback with the same handler as /play', () => {
  const play = commands.find((command) => command.data.name === 'play');
  const k2 = commands.find((command) => command.data.name === 'k2');
  assert.ok(play);
  assert.ok(k2);
  assert.equal(k2.execute, play.execute);
  const option = k2.data.toJSON().options[0];
  assert.equal(option.name, 'query');
  assert.equal(option.required, true);
});

test('the player embed shows the track number and updates the following numbers', () => {
  const session = {
    current: { title: 'Now', artist: 'A', requester: 'Nizar', durationMs: 180000 },
    upcoming: [
      { title: 'Next', durationMs: 1000 },
      { title: 'Later', durationMs: 1000 },
    ],
    positionMs: 60000,
    paused: false,
    queue: {
      loopMode: 'off',
      position() {
        return { index: 3, total: 5 };
      },
    },
    filter: 'off',
    history: [],
  };
  const description = playerMessage(session).embeds[0].toJSON().description;
  assert.match(description, /Track 3 of 5/);
  assert.match(description, /4\. Next/);
  assert.match(description, /5\. Later/);
});

test('/skipto takes the track number shown in the player', () => {
  const command = commands.find((entry) => entry.data.name === 'skipto');
  assert.equal(command.execute.name, 'executeSkipTo');
  const option = command.data.toJSON().options[0];
  assert.equal(option.name, 'number');
  assert.equal(option.required, true);
});

test('a play gif is posted only when a song starts', async () => {
  const sent = [];
  const interaction = {
    async followUp(payload) {
      sent.push(payload.content);
    },
  };
  const music = { config: { playGifUrl: 'https://example.com/play.gif' } };
  await sendPlayGif(interaction, music, { started: true, outcome: { ok: true } });
  await sendPlayGif(interaction, music, { started: false, outcome: { ok: true } });
  await sendPlayGif(interaction, { config: {} }, { started: true, outcome: { ok: true } });
  assert.deepEqual(sent, ['https://example.com/play.gif']);
});
