const test = require('node:test');
const assert = require('node:assert/strict');
const { GuildQueue, MAX_QUEUE } = require('../src/music/queue');

function track(title) {
  return { title, artist: 'Artist', source: 'local' };
}

test('queues from two servers do not share tracks', () => {
  const first = new GuildQueue('111');
  const second = new GuildQueue('222');
  first.enqueue([track('One')]);
  second.enqueue([track('Two')]);
  assert.equal(first.upcoming.length, 1);
  assert.equal(second.upcoming[0].title, 'Two');
  first.shiftNext();
  assert.equal(first.current.title, 'One');
  assert.equal(second.current, null);
});

test('the queue stops accepting tracks at the cap', () => {
  const queue = new GuildQueue('1');
  const tracks = Array.from({ length: MAX_QUEUE + 5 }, (_, index) => track(`Song ${index}`));
  const result = queue.enqueue(tracks);
  assert.equal(result.accepted.length, MAX_QUEUE);
  assert.equal(result.skipped, 5);
  assert.equal(queue.freeSlots(), 0);
});

test('clear removes upcoming songs and leaves the current one', () => {
  const queue = new GuildQueue('1');
  queue.enqueue([track('Now'), track('Next')]);
  queue.shiftNext();
  assert.equal(queue.clearUpcoming(), 1);
  assert.equal(queue.current.title, 'Now');
  assert.equal(queue.upcoming.length, 0);
});

test('previous puts the last track back in front without dropping the rest', () => {
  const queue = new GuildQueue('1');
  queue.enqueue([track('A'), track('B'), track('C')]);
  queue.shiftNext();
  queue.shiftNext();
  assert.equal(queue.current.title, 'B');
  assert.equal(queue.previous().title, 'A');
  queue.shiftNext();
  assert.equal(queue.current.title, 'A');
  assert.deepEqual(queue.upcoming.map((item) => item.title), ['B', 'C']);
  assert.equal(queue.history.length, 0);
});

test('play now moves the new track ahead of the current one', () => {
  const queue = new GuildQueue('1');
  queue.enqueue([track('A'), track('B')]);
  queue.shiftNext();
  queue.placeNow([track('Now')]);
  queue.shiftNext();
  assert.equal(queue.current.title, 'Now');
  assert.equal(queue.history[0].title, 'A');
  assert.equal(queue.upcoming[0].title, 'B');
});

test('move and remove use 1-based positions', () => {
  const queue = new GuildQueue('1');
  queue.enqueue([track('A'), track('B'), track('C')]);
  assert.equal(queue.move(3, 1).title, 'C');
  assert.deepEqual(queue.upcoming.map((item) => item.title), ['C', 'A', 'B']);
  assert.equal(queue.removeAt(2).title, 'A');
  assert.deepEqual(queue.upcoming.map((item) => item.title), ['C', 'B']);
  assert.equal(queue.removeAt(5), null);
  assert.equal(queue.move(1, 9), null);
});

test('another add keeps the songs already queued', () => {
  const queue = new GuildQueue('1');
  queue.enqueue([track('A'), track('B'), track('C')]);
  queue.shiftNext();
  queue.enqueue([track('D')]);
  assert.equal(queue.current.title, 'A');
  assert.deepEqual(queue.upcoming.map((item) => item.title), ['B', 'C', 'D']);
  assert.deepEqual(queue.position(), { index: 1, total: 4 });
});

test('skip to a later track keeps that track number', () => {
  const queue = new GuildQueue('1');
  queue.enqueue([track('A'), track('B'), track('C'), track('D'), track('E')]);
  queue.shiftNext();
  assert.equal(queue.skipTo(4).title, 'D');
  queue.shiftNext();
  assert.equal(queue.current.title, 'D');
  assert.deepEqual(queue.position(), { index: 4, total: 5 });
  assert.equal(queue.upcomingIndex(5), 1);
  assert.equal(queue.skipTo(4), null);
  assert.equal(queue.current.title, 'D');
});

test('shuffle keeps every queued track and reset turns loop off', () => {
  const queue = new GuildQueue('1');
  queue.enqueue([track('A'), track('B'), track('C'), track('D')]);
  queue.loopMode = 'queue';
  assert.equal(queue.shuffle(), 4);
  assert.deepEqual(queue.upcoming.map((item) => item.title).sort(), ['A', 'B', 'C', 'D']);
  queue.reset();
  assert.equal(queue.loopMode, 'off');
  assert.equal(queue.upcoming.length, 0);
});
