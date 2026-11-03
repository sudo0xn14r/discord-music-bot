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
