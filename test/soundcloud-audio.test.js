const http = require('node:http');
const { EventEmitter, PassThrough } = require('node:stream');
const test = require('node:test');
const assert = require('node:assert/strict');
const { LavalinkSource } = require('../src/providers/lavalink-source');
const { resetSoundCloudClientId } = require('../src/providers/soundcloud-public');
const { setSoundCloudTranscoder } = require('../src/music/soundcloud-audio');

function scriptResponse(body) {
  return { ok: true, status: 200, async text() { return body; } };
}

test('a soundcloud track is played as a local mp3 stream', async () => {
  resetSoundCloudClientId();
  const originalFetch = global.fetch;
  setSoundCloudTranscoder(() => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.end(Buffer.from('ID3sound'));
      child.emit('exit', 0);
    });
    return child;
  });
  global.fetch = async (url) => {
    const target = String(url);
    if (target === 'https://soundcloud.com/') {
      return scriptResponse('<script src="https://a-v2.sndcdn.com/assets/app.js"></script>');
    }
    if (target.endsWith('/app.js')) {
      return scriptResponse('},{client_id:"abcdefghijklmnopqrstuvwxyz012345"}');
    }
    if (target.includes('/resolve?')) {
      return scriptResponse(JSON.stringify({
        kind: 'track',
        title: 'Bones - Sodium',
        media: {
          transcodings: [{
            url: 'https://api-v2.soundcloud.com/media/track/stream',
            snipped: false,
            preset: 'aac_160k',
            format: { protocol: 'hls', mime_type: 'audio/mp4' },
          }],
        },
      }));
    }
    if (target.includes('/media/track/stream')) {
      return scriptResponse(JSON.stringify({ url: 'https://playback.example/playlist.m3u8' }));
    }
    return { ok: false, status: 404, async text() { return ''; } };
  };
  try {
    const source = new LavalinkSource(() => null, true);
    const playback = await source.playbackIdentifier({
      identifier: 'https://soundcloud.com/teamsesh/bones-sodium',
      pageUrl: 'https://soundcloud.com/teamsesh/bones-sodium',
    });
    assert.match(playback, /^http:\/\/127\.0\.0\.1:\d+\/sc\/[a-f0-9]+$/);
    const body = await new Promise((resolve, reject) => {
      http.get(playback, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }).on('error', reject);
    });
    assert.equal(body.toString(), 'ID3sound');
  } finally {
    global.fetch = originalFetch;
    setSoundCloudTranscoder(null);
    resetSoundCloudClientId();
  }
});
