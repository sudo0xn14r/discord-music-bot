const test = require('node:test');
const assert = require('node:assert/strict');
const { commands, sendPlayGif } = require('../src/commands');

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
