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
  assert.match(result.notice, /top search result/);
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
