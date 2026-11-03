const { log } = require('../util/log');

const HOUR_MS = 60 * 60 * 1000;

function startHealth({ lavalink, client, config }) {
  let lastState = null;
  let lastAlert = 0;

  const timer = setInterval(() => {
    void check();
  }, 30000);
  timer.unref?.();

  async function check() {
    await pingUptime();
    const node = lavalink.getIdealNode();
    if (!node) {
      if (lastState !== 'down') log('error', 'node is not connected', { source: 'lavalink' });
      lastState = 'down';
      await alertOwner('The audio server is disconnected. The bot is still online and will keep retrying.');
      return;
    }
    try {
      await node.rest.getLavalinkInfo();
      if (lastState !== 'up') log('info', 'node is healthy', { source: 'lavalink', node: node.name });
      lastState = 'up';
    } catch (error) {
      log('error', 'health check failed', { source: 'lavalink', node: node.name, error: error.message });
      if (lastState !== 'unhealthy') await alertOwner('The audio server failed a health check. Playback may be interrupted.');
      lastState = 'unhealthy';
    }
  }

  async function pingUptime() {
    if (!config.uptimeUrl) return;
    try {
      const response = await fetch(config.uptimeUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) log('error', 'uptime ping failed', { status: response.status });
    } catch (error) {
      log('error', 'uptime ping failed', { error: error.message });
    }
  }

  async function alertOwner(text) {
    if (!config.ownerId || !client.isReady()) return;
    if (Date.now() - lastAlert < HOUR_MS) return;
    lastAlert = Date.now();
    try {
      const user = await client.users.fetch(config.ownerId);
      await user.send(text);
    } catch (error) {
      log('error', 'could not message the owner', { error: error.message });
    }
  }

  return () => clearInterval(timer);
}

module.exports = { startHealth };
