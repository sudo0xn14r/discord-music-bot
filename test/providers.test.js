const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalLibrary } = require('../src/providers/local-library');
const { ProviderManager } = require('../src/providers/provider-manager');
const { tracksFromPlaylist } = require('../src/music/playlist');
const { resolveRequest } = require('../src/music/resolver');
const { createTrack } = require('../src/music/track');
const { YoutubeProvider } = require('../src/providers/youtube');
const { SpotifyProvider, parseSpotifyEmbed } = require('../src/providers/spotify');
const { UserError } = require('../src/errors');
const { trackIsPlayable } = require('../src/providers/soundcloud');
const { openDatabase } = require('../src/db');

function libraryWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'music-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return new LocalLibrary({ localMusicDir: root, enabled: true });
}

test('the local library matches an authorized file and ignores a different title', async () => {
  const library = libraryWith({
    'Kendrick Lamar - Not Like Us.mp3': 'audio',
    'Other Artist - HUMBLE.mp3': 'audio',
  });
  const match = await library.findMatch({ title: 'Not Like Us', artist: 'Kendrick Lamar', durationMs: 240000 });
  assert.equal(match.title, 'Not Like Us');
  assert.equal(await library.findMatch({ title: 'tv off', artist: 'Kendrick Lamar' }), null);
  const search = await library.search('not like us', 5);
  assert.equal(search.length, 1);
  assert.equal((await library.search('completely different', 5)).length, 0);
});

test('a path outside the music folder is not playable', () => {
  const library = libraryWith({ 'Artist - Song.mp3': 'audio' });
  const outside = path.join(os.tmpdir(), `secret-${Date.now()}.mp3`);
  fs.writeFileSync(outside, 'nope');
  assert.equal(library.owns(outside), false);
  assert.equal(library.owns(path.join(library.root, '..', path.basename(outside))), false);
  assert.equal(library.owns(path.join(library.root, 'Artist - Song.mp3')), true);
  fs.unlinkSync(outside);
});

test('a provider failure does not hide a later match', async () => {
  const manager = ProviderManager.fromList([
    {
      name: 'soundcloud',
      label: 'SoundCloud',
      canPlay: true,
      enabled: () => true,
      available: async () => true,
      status: () => 'enabled',
      async search() {
        throw new Error('soundcloud down');
      },
      async findMatch() {
        throw new Error('soundcloud down');
      },
    },
    {
      name: 'local',
      label: 'the local library',
      canPlay: true,
      enabled: () => true,
      available: async () => true,
      status: () => 'enabled',
      looksLikePath: () => false,
      async search() {
        return [createTrack({ title: 'Not Like Us', artist: 'Kendrick Lamar', source: 'local', filePath: '/music/a.mp3' })];
      },
      async findMatch(metadata) {
        if (metadata.title === 'Not Like Us') {
          return createTrack({ title: 'Not Like Us', artist: 'Kendrick Lamar', source: 'local', filePath: '/music/a.mp3' });
        }
        return null;
      },
    },
  ], ['soundcloud', 'local']);

  const found = await manager.search('not like us', 1);
  assert.equal(found[0].source, 'local');
  const match = await manager.findMatch({ title: 'Not Like Us', artist: 'Kendrick Lamar' });
  assert.equal(match.filePath, '/music/a.mp3');
});

test('text search rejects an unrelated provider result', async () => {
  const manager = ProviderManager.fromList([
    {
      name: 'local',
      label: 'the local library',
      canPlay: true,
      enabled: () => true,
      available: async () => true,
      status: () => 'enabled',
      looksLikePath: () => false,
      async search() {
        return [createTrack({ title: 'HUMBLE.', artist: 'Kendrick Lamar', source: 'local' })];
      },
      async findMatch() {
        return null;
      },
    },
  ], ['local']);
  assert.deepEqual(await manager.search('not like us', 1), []);
  await assert.rejects(
    () => resolveRequest('not like us', 'Nizar', 1, manager),
    (error) => error instanceof UserError && /Nothing else was substituted/.test(error.message),
  );
});

test('youtube links resolve through the youtube provider and do not search', async () => {
  let searched = false;
  let resolved = null;
  const manager = ProviderManager.fromList([
    {
      name: 'youtube',
      label: 'YouTube',
      canPlay: true,
      enabled: () => true,
      available: async () => true,
      status: () => 'enabled',
      async search() {
        searched = true;
        return [];
      },
      async resolveUrl(input, requester) {
        resolved = input;
        return {
          tracks: [createTrack({
            title: 'Video',
            artist: 'Artist',
            source: 'youtube',
            identifier: input,
            requester,
          })],
          truncated: false,
        };
      },
      friendly(error) {
        return error.message;
      },
    },
    {
      name: 'local',
      label: 'the local library',
      canPlay: true,
      enabled: () => true,
      available: async () => true,
      looksLikePath: () => false,
      async search() {
        searched = true;
        return [];
      },
    },
  ], ['youtube', 'local']);
  const result = await resolveRequest('https://youtu.be/dQw4w9WgXcQ', 'Nizar', 1, manager);
  assert.equal(searched, false);
  assert.equal(resolved, 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(result.tracks[0].source, 'youtube');
  assert.equal(result.tracks[0].identifier, 'https://youtu.be/dQw4w9WgXcQ');
});

test('a disabled youtube provider refuses a youtube link', async () => {
  const manager = ProviderManager.fromList([
    {
      name: 'youtube',
      label: 'YouTube',
      canPlay: true,
      enabled: () => false,
      available: async () => false,
    },
  ], ['local']);
  await assert.rejects(
    () => resolveRequest('https://www.youtube.com/watch?v=abc', 'Nizar', 1, manager),
    (error) => error instanceof UserError && /Add youtube to PROVIDER_ORDER/.test(error.message),
  );
});

function youtubeNode(hits) {
  const identifiers = [];
  const youtube = new YoutubeProvider(() => ({
    name: 'main',
    rest: {
      async resolve(identifier) {
        identifiers.push(identifier);
        if (String(identifier).startsWith('ytsearch:')) {
          return { loadType: 'search', data: hits };
        }
        return {
          loadType: 'track',
          data: hits[0] || { info: { title: 'Video', author: 'Artist', uri: identifier, length: 1000 } },
        };
      },
    },
  }), true);
  return { youtube, identifiers };
}

test('a blocked youtube watch page plays the search result for that video', async () => {
  const identifiers = [];
  const youtube = new YoutubeProvider(() => ({
    rest: {
      async resolve(identifier) {
        identifiers.push(identifier);
        if (String(identifier).startsWith('ytsearch:')) {
          return {
            loadType: 'search',
            data: [{
              encoded: 'encoded-track',
              info: {
                title: 'Haroun',
                author: 'El Rass',
                length: 180000,
                uri: 'https://www.youtube.com/watch?v=-q7_fmVGHEw',
              },
            }],
          };
        }
        return { loadType: 'error', data: { message: 'This video requires login.' } };
      },
    },
  }), true);
  const result = await youtube.resolveUrl('https://youtu.be/-q7_fmVGHEw', 'Nizar');
  assert.equal(result.tracks[0].encoded, 'encoded-track');
  assert.equal(result.tracks[0].title, 'Haroun');
  assert.equal(result.tracks[0].requester, 'Nizar');
  assert.equal(identifiers.some((item) => item.startsWith('ytsearch:')), true);
});

test('a blocked youtube link is not replaced with a different video', async () => {
  const youtube = new YoutubeProvider(() => ({
    rest: {
      async resolve(identifier) {
        if (String(identifier).startsWith('ytsearch:')) {
          return {
            loadType: 'search',
            data: [{
              encoded: 'other',
              info: { title: 'Other', author: 'Someone', length: 1000, uri: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' },
            }],
          };
        }
        return { loadType: 'error', data: { message: 'This video requires login.' } };
      },
    },
  }), true);
  await assert.rejects(
    () => youtube.resolveUrl('https://www.youtube.com/watch?v=bbbbbbbbbbb', 'Nizar'),
    (error) => error.userError && /could not be played/.test(error.message),
  );
});

test('youtube search uses ytsearch and falls back to the top result', async () => {
  const { youtube, identifiers } = youtubeNode([
    { info: { title: 'Unrelated Mix', author: 'Other', length: 1000, uri: 'https://www.youtube.com/watch?v=aaa' } },
  ]);
  const manager = ProviderManager.fromList([youtube], ['youtube']);
  const result = await resolveRequest('not like us', 'Nizar', 1, manager);
  assert.equal(identifiers[0], 'ytsearch:not like us');
  assert.equal(result.tracks[0].source, 'youtube');
  assert.equal(result.tracks[0].title, 'Unrelated Mix');
  assert.equal(result.tracks[0].loose, true);
  assert.match(result.notice, /top result/);
});

test('a close youtube match is kept and a later loose hit is not used', async () => {
  const { youtube, identifiers } = youtubeNode([
    { info: { title: 'Not Like Us', author: 'Kendrick Lamar', length: 240000, uri: 'https://www.youtube.com/watch?v=bbb' } },
    { info: { title: 'Unrelated Mix', author: 'Other', length: 1000, uri: 'https://www.youtube.com/watch?v=aaa' } },
  ]);
  const manager = ProviderManager.fromList([youtube], ['youtube']);
  const result = await resolveRequest('Kendrick Lamar - Not Like Us', 'Nizar', 1, manager);
  assert.equal(identifiers.length, 1);
  assert.equal(result.tracks[0].title, 'Not Like Us');
  assert.equal(result.tracks[0].loose, undefined);
  assert.equal(result.notice, null);
});

test('spotify metadata falls back to the top youtube result when nothing is close', async () => {
  const { youtube } = youtubeNode([
    { info: { title: 'Some Other Song', author: 'Someone', length: 200000, uri: 'https://www.youtube.com/watch?v=ccc' } },
  ]);
  const spotify = {
    name: 'spotify',
    label: 'Spotify',
    canPlay: false,
    enabled: () => true,
    status: () => 'enabled for metadata',
    async resolveMetadata() {
      return { kind: 'tracks', tracks: [{ title: 'tv off', artist: 'Kendrick Lamar', durationMs: 180000 }] };
    },
    friendly(error) {
      return error.message;
    },
  };
  const manager = ProviderManager.fromList([spotify, youtube], ['youtube']);
  const result = await resolveRequest('https://open.spotify.com/track/missing', 'Nizar', 5, manager);
  assert.equal(result.tracks[0].source, 'youtube');
  assert.equal(result.tracks[0].title, 'Some Other Song');
  assert.equal(result.tracks[0].matchedFrom, 'spotify');
  assert.equal(result.tracks[0].loose, true);
  assert.equal(result.notice, null);
});

test('a strict local match still beats an unrelated youtube hit', async () => {
  const library = libraryWith({ 'Kendrick Lamar - Not Like Us.mp3': 'audio' });
  const { youtube } = youtubeNode([
    { info: { title: 'Unrelated Mix', author: 'Other', length: 1000, uri: 'https://www.youtube.com/watch?v=aaa' } },
  ]);
  const manager = ProviderManager.fromList([youtube, library], ['youtube', 'local']);
  const result = await resolveRequest('Kendrick Lamar - Not Like Us', 'Nizar', 1, manager);
  assert.equal(result.tracks[0].source, 'local');
  assert.equal(result.notice, null);
});

test('saved youtube tracks load when the provider is enabled', () => {
  const providers = {
    get(name) {
      if (name !== 'youtube') return null;
      return { enabled: () => true };
    },
  };
  const loaded = tracksFromPlaylist([
    { title: 'Video', artist: 'Artist', source: 'youtube', identifier: 'https://www.youtube.com/watch?v=abc' },
    { title: 'Gone', artist: 'Artist', source: 'youtube' },
  ], providers, 'Nizar');
  assert.equal(loaded.tracks.length, 1);
  assert.equal(loaded.tracks[0].source, 'youtube');
  assert.equal(loaded.tracks[0].identifier, 'https://www.youtube.com/watch?v=abc');
  assert.equal(loaded.missing, 1);
  const disabled = tracksFromPlaylist([
    { title: 'Video', artist: 'Artist', source: 'youtube', identifier: 'https://www.youtube.com/watch?v=abc' },
  ], { get: () => ({ enabled: () => false }) }, 'Nizar');
  assert.equal(disabled.tracks.length, 0);
  assert.equal(disabled.missing, 1);
});

test('spotify metadata is not replaced with an unrelated track', async () => {
  const library = libraryWith({ 'Kendrick Lamar - Not Like Us.mp3': 'audio' });
  const spotify = {
    name: 'spotify',
    label: 'Spotify',
    canPlay: false,
    enabled: () => true,
    status: () => 'enabled for metadata',
    async resolveMetadata(input) {
      if (String(input).includes('missing')) {
        return { kind: 'tracks', tracks: [{ title: 'tv off', artist: 'Kendrick Lamar', durationMs: 180000 }] };
      }
      return { kind: 'tracks', tracks: [{ title: 'Not Like Us', artist: 'Kendrick Lamar', durationMs: 240000 }] };
    },
    friendly(error) {
      return error.message;
    },
  };
  const manager = ProviderManager.fromList([spotify, library], ['local']);
  const result = await resolveRequest('https://open.spotify.com/track/abc123', 'Nizar', 5, manager);
  assert.equal(result.tracks[0].title, 'Not Like Us');
  assert.equal(result.tracks[0].source, 'local');
  assert.equal(result.tracks[0].matchedFrom, 'spotify');
  await assert.rejects(
    () => resolveRequest('https://open.spotify.com/track/missing', 'Nizar', 5, manager),
    (error) => error instanceof UserError && /Nothing else was substituted/.test(error.message),
  );
});

test('a soundcloud link plays the track and a set plays each track', async () => {
  const seen = [];
  const lavalink = {
    name: 'lavalink',
    label: 'SoundCloud',
    canPlay: true,
    enabled: () => true,
    async resolveUrl(input, requester) {
      seen.push(input);
      const tracks = String(input).includes('/sets/')
        ? [
          createTrack({ title: 'One', artist: 'Artist', source: 'lavalink', requester, identifier: `${input}#1` }),
          createTrack({ title: 'Two', artist: 'Artist', source: 'lavalink', requester, identifier: `${input}#2` }),
        ]
        : [createTrack({ title: 'Faded', artist: 'Alan Walker', source: 'lavalink', requester, identifier: input })];
      return { tracks, restricted: 0, truncated: false };
    },
    friendly(error) {
      return error.message;
    },
  };
  const manager = ProviderManager.fromList([lavalink], ['lavalink']);
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('a full SoundCloud link does not need a lookup');
  };
  try {
    const track = await resolveRequest('https://m.soundcloud.com/alanwalker/faded?si=tracking', 'Nizar', 5, manager);
    assert.equal(seen[0], 'https://soundcloud.com/alanwalker/faded');
    assert.equal(track.tracks[0].title, 'Faded');
    assert.equal(track.tracks[0].requester, 'Nizar');
    const set = await resolveRequest('https://soundcloud.com/artist/sets/night?utm_source=share', 'Nizar', 5, manager);
    assert.equal(seen[1], 'https://soundcloud.com/artist/sets/night');
    assert.deepEqual(set.tracks.map((item) => item.title), ['One', 'Two']);
    const secret = await resolveRequest('https://soundcloud.com/artist/private?secret_token=s-abc&si=1', 'Nizar', 1, manager);
    assert.equal(seen[2], 'https://soundcloud.com/artist/private?secret_token=s-abc');
    assert.equal(secret.tracks[0].title, 'Faded');
    await assert.rejects(
      () => resolveRequest('https://soundcloud.com/artist', 'Nizar', 1, manager),
      (error) => error instanceof UserError && /track or playlist/.test(error.message),
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('a soundcloud short link is opened before playback', async () => {
  const seen = [];
  const lavalink = {
    name: 'lavalink',
    label: 'SoundCloud',
    canPlay: true,
    enabled: () => true,
    async resolveUrl(input) {
      seen.push(input);
      return {
        tracks: [createTrack({ title: 'Sodium', artist: 'Bones', source: 'lavalink', identifier: input })],
        restricted: 0,
        truncated: false,
      };
    },
    friendly(error) {
      return error.message;
    },
  };
  const manager = ProviderManager.fromList([lavalink], ['lavalink']);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.equal(url, 'https://on.soundcloud.com/AbCd12');
    return {
      status: 302,
      headers: { get: (name) => (name === 'location' ? 'https://soundcloud.com/bones/sodium?si=1' : null) },
    };
  };
  try {
    const result = await resolveRequest('https://on.soundcloud.com/AbCd12', 'Nizar', 1, manager);
    assert.equal(seen[0], 'https://soundcloud.com/bones/sodium');
    assert.equal(result.tracks[0].title, 'Sodium');
  } finally {
    global.fetch = originalFetch;
  }
});

test('a soundcloud short link that leaves soundcloud is refused', async () => {
  const lavalink = {
    name: 'lavalink',
    label: 'SoundCloud',
    canPlay: true,
    enabled: () => true,
    async resolveUrl() {
      throw new Error('should not play');
    },
    friendly(error) {
      return error.message;
    },
  };
  const manager = ProviderManager.fromList([lavalink], ['lavalink']);
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    status: 302,
    headers: { get: () => 'https://example.com/not-soundcloud' },
  });
  try {
    await assert.rejects(
      () => resolveRequest('https://snd.sc/AbCd12', 'Nizar', 1, manager),
      (error) => error instanceof UserError && /did not stay on SoundCloud/.test(error.message),
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('soundcloud falls back to the official api when lavalink cannot load the link', async () => {
  const lavalink = {
    name: 'lavalink',
    label: 'SoundCloud',
    canPlay: true,
    enabled: () => true,
    async resolveUrl() {
      const error = new Error('That link could not be played.');
      error.userError = true;
      throw error;
    },
    friendly(error) {
      return error.message;
    },
  };
  const soundcloud = {
    name: 'soundcloud',
    label: 'SoundCloud',
    canPlay: true,
    enabled: () => true,
    async resolveUrl(input, requester) {
      return {
        tracks: [createTrack({ title: 'From API', artist: 'Artist', source: 'soundcloud', requester, identifier: input })],
        restricted: 0,
        truncated: false,
      };
    },
    friendly(error) {
      return error.message;
    },
  };
  const manager = ProviderManager.fromList([lavalink, soundcloud], ['lavalink', 'soundcloud']);
  const result = await resolveRequest('https://soundcloud.com/artist/track', 'Nizar', 1, manager);
  assert.equal(result.tracks[0].title, 'From API');
  assert.equal(result.tracks[0].source, 'soundcloud');
});

test('soundcloud only treats full allowed tracks as playable', () => {
  assert.equal(trackIsPlayable({ id: 1, title: 'Song', access: 'playable', streamable: true }), true);
  assert.equal(trackIsPlayable({ id: 1, title: 'Song', access: 'preview', streamable: true }), false);
  assert.equal(trackIsPlayable({ id: 1, title: 'Song', access: 'blocked' }), false);
  assert.equal(trackIsPlayable({
    id: 1,
    title: 'Song',
    streamable: true,
    media: { transcodings: [{ url: 'https://example.com/a', snipped: true, format: { protocol: 'progressive' } }] },
  }), false);
  assert.equal(trackIsPlayable({
    id: 1,
    title: 'Song',
    streamable: true,
    media: { transcodings: [{ url: 'https://example.com/a', snipped: false, format: { protocol: 'progressive' } }] },
  }), true);
});

function embedPage(entity) {
  const payload = { props: { pageProps: { state: { data: { entity } } } } };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
}

test('a public spotify page supplies the title, artist, and duration', () => {
  const result = parseSpotifyEmbed(embedPage({
    type: 'track',
    title: 'Never Gonna Give You Up',
    artists: [{ name: 'Rick Astley' }],
    duration: 213573,
  }), { type: 'track', id: '4cOdK2wGLETKBW3PvgPWqT' });
  assert.equal(result.kind, 'tracks');
  assert.equal(result.tracks[0].title, 'Never Gonna Give You Up');
  assert.equal(result.tracks[0].artist, 'Rick Astley');
  assert.equal(result.tracks[0].durationMs, 213573);
});

test('a spotify playlist page keeps the first 50 songs', () => {
  const trackList = Array.from({ length: 60 }, (_, index) => ({
    uri: `spotify:track:track${index}`,
    title: `Song ${index}`,
    subtitle: 'Artist',
    duration: 1000,
  }));
  const result = parseSpotifyEmbed(embedPage({
    type: 'playlist',
    name: 'Friday',
    trackList,
  }), { type: 'playlist', id: 'list1' });
  assert.equal(result.tracks.length, 50);
  assert.equal(result.tracks[0].artist, 'Artist');
  assert.equal(result.tracks[0].pageUrl, 'https://open.spotify.com/track/track0');
});

test('a refused spotify app falls back to the public page', async () => {
  const provider = new SpotifyProvider({ spotify: { clientId: 'id', clientSecret: 'secret' } });
  const html = embedPage({
    type: 'track',
    title: 'Never Gonna Give You Up',
    artists: [{ name: 'Rick Astley' }],
    duration: 213573,
  });
  const original = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.includes('accounts.spotify.com')) {
      return { ok: false, status: 403, async text() { return '{"error":"forbidden"}'; } };
    }
    if (href.includes('open.spotify.com/embed/')) {
      return { ok: true, status: 200, async text() { return html; } };
    }
    throw new Error(href);
  };
  try {
    const result = await provider.resolveMetadata('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
    assert.equal(result.tracks[0].title, 'Never Gonna Give You Up');
    assert.equal(result.tracks[0].artist, 'Rick Astley');
  } finally {
    global.fetch = original;
  }
});

test('server settings, playlists, and history stay separate', () => {
  const database = openDatabase(':memory:');
  database.setVolume('guild-a', 40);
  database.setVolume('guild-b', 90);
  assert.equal(database.getGuild('guild-a').volume, 40);
  assert.equal(database.getGuild('guild-b').volume, 90);
  database.savePlaylist('guild-a', 'Friday', [
    createTrack({ title: 'One', artist: 'A', source: 'local', filePath: '/music/one.mp3' }),
  ], 'Nizar');
  database.addHistory('guild-a', createTrack({ title: 'One', artist: 'A', source: 'local', requester: 'Nizar' }));
  database.addHistory('guild-b', createTrack({ title: 'Two', artist: 'B', source: 'soundcloud', requester: 'Friend' }));
  assert.equal(database.listPlaylists('guild-b').length, 0);
  assert.equal(database.loadPlaylist('guild-a', 'friday').tracks[0].filePath, '/music/one.mp3');
  assert.equal(database.recentHistory('guild-a', 10)[0].title, 'One');
  assert.equal(database.recentHistory('guild-b', 10)[0].title, 'Two');
  assert.equal(database.deletePlaylist('guild-a', 'Friday'), true);
  assert.equal(database.loadPlaylist('guild-a', 'Friday'), null);
  database.close();
});
