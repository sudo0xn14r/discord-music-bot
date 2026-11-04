const http = require('node:http');
const { EventEmitter, PassThrough } = require('node:stream');
const test = require('node:test');
const assert = require('node:assert/strict');
const { LavalinkSource } = require('../src/providers/lavalink-source');
const { resetSoundCloudClientId, soundCloudMediaUrl } = require('../src/providers/soundcloud-public');
const { setSoundCloudTranscoder } = require('../src/music/soundcloud-audio');

function scriptResponse(body) {
  return { ok: true, status: 200, async text() { return body; } };
}

test('a locked soundcloud upload plays another copy of the same song', async () => {
  resetSoundCloudClientId();
  const originalFetch = global.fetch;
  const fetched = [];
  global.fetch = async (url) => {
    const target = String(url);
    fetched.push(target);
    if (target === 'https://soundcloud.com/') {
      return scriptResponse('<script src="https://a-v2.sndcdn.com/assets/app.js"></script>');
    }
    if (target.endsWith('/app.js')) {
      return scriptResponse('},{client_id:"abcdefghijklmnopqrstuvwxyz012345"}');
    }
    if (target.includes('/resolve?')) {
      return scriptResponse(JSON.stringify({
        kind: 'track',
        id: 1,
        title: 'سلام وعن بعد',
        duration: 509600,
        media: {
          transcodings: [{
            url: 'https://api-v2.soundcloud.com/media/locked/stream',
            snipped: false,
            preset: 'aac_160k',
            format: { protocol: 'cbc-encrypted-hls', mime_type: 'audio/mp4' },
          }],
        },
      }));
    }
    if (target.includes('/search/tracks')) {
      return scriptResponse(JSON.stringify({
        collection: [
          {
            id: 2,
            title: 'سلام وعن بعد بطيء',
            duration: 230000,
            media: {
              transcodings: [{
                url: 'https://api-v2.soundcloud.com/media/short/stream',
                snipped: false,
                preset: 'aac_160k',
                format: { protocol: 'hls', mime_type: 'audio/mp4' },
              }],
            },
          },
          {
            id: 3,
            title: 'سلام وعن بعد سيد سلام',
            duration: 509700,
            media: {
              transcodings: [{
                url: 'https://api-v2.soundcloud.com/media/copy/stream',
                snipped: false,
                preset: 'aac_160k',
                format: { protocol: 'hls', mime_type: 'audio/mp4' },
              }],
            },
          },
        ],
      }));
    }
    if (target.includes('/media/copy/stream')) {
      return scriptResponse(JSON.stringify({ url: 'https://playback.example/copy.m3u8' }));
    }
    return { ok: false, status: 404, async text() { return ''; } };
  };
  try {
    const media = await soundCloudMediaUrl('https://soundcloud.com/artist/locked');
    assert.equal(media, 'https://playback.example/copy.m3u8');
    assert.equal(fetched.some((url) => url.includes('/media/short/stream')), false);
  } finally {
    global.fetch = originalFetch;
    resetSoundCloudClientId();
  }
});

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
