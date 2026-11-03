const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isYouTubeUrl,
  pickBestMatch,
  queryMatches,
  spotifyTarget,
  titlesMatch,
} = require('../src/providers/match');

test('youtube links are recognized and other hosts are not', () => {
  assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=abc'), true);
  assert.equal(isYouTubeUrl('https://youtu.be/abc'), true);
  assert.equal(isYouTubeUrl('https://music.youtube.com/watch?v=abc'), true);
  assert.equal(isYouTubeUrl('https://www.youtube-nocookie.com/embed/abc'), true);
  assert.equal(isYouTubeUrl('https://soundcloud.com/artist/track'), false);
  assert.equal(isYouTubeUrl('not a url'), false);
});

test('spotify targets keep the id from urls and uris', () => {
  assert.deepEqual(
    spotifyTarget('https://open.spotify.com/intl-en/track/abc123?si=1'),
    { type: 'track', id: 'abc123' },
  );
  assert.deepEqual(spotifyTarget('spotify:album:xyz789'), { type: 'album', id: 'xyz789' });
  assert.equal(spotifyTarget('https://example.com/track/abc'), null);
});

test('title matching rejects a different song', () => {
  const wanted = { title: 'Not Like Us', artist: 'Kendrick Lamar' };
  assert.equal(titlesMatch(wanted, { title: 'Not Like Us', artist: 'Kendrick Lamar' }), true);
  assert.equal(titlesMatch(wanted, { title: 'Not Like Us (Official Audio)', artist: 'Kendrick Lamar' }), true);
  assert.equal(titlesMatch(wanted, { title: 'HUMBLE.', artist: 'Kendrick Lamar' }), false);
  assert.equal(titlesMatch(wanted, { title: 'Not Like Us', artist: 'Someone Else' }), false);
  assert.equal(titlesMatch(
    { title: 'Not Like Us Kendrick Live Set', artist: 'Kendrick Lamar' },
    { title: 'Not Like Us', artist: 'Kendrick Lamar' },
  ), false);
});

test('search matching does not accept an unrelated title', () => {
  assert.equal(queryMatches('not like us', { title: 'Not Like Us', artist: 'Kendrick Lamar' }), true);
  assert.equal(queryMatches('Kendrick Lamar - Not Like Us', { title: 'Not Like Us', artist: 'Kendrick Lamar' }), true);
  assert.equal(queryMatches('not like us', { title: 'HUMBLE.', artist: 'Kendrick Lamar' }), false);
  assert.equal(queryMatches('us', { title: 'Not Like Us', artist: 'Kendrick' }), false);
});

test('the best match cannot be a preview or a different song', () => {
  const wanted = { title: 'Not Like Us', artist: 'Kendrick Lamar', durationMs: 240000 };
  const chosen = pickBestMatch(wanted, [
    { title: 'Random Mix', artist: 'DJ', durationMs: 240000 },
    { title: 'Not Like Us', artist: 'Kendrick Lamar', durationMs: 30000 },
    { title: 'Not Like Us', artist: 'Kendrick Lamar', durationMs: 241000 },
  ]);
  assert.equal(chosen.durationMs, 241000);
  assert.equal(pickBestMatch(wanted, [{ title: 'Random Mix', artist: 'DJ', durationMs: 240000 }]), null);
});
