const HOUR_MS = 60 * 60 * 1000;

function startHealth({ lavalink, client, config }) {
  let lastState = null;
  let lastAlert = 0;

  const timer = setInterval(() => {
    void check();
  }, 30000);
  timer.unref?.();

  async function check() {
    const node = lavalink.getIdealNode();
    if (!node) {
      if (lastState !== 'down') console.error('[lavalink] node is not connected');
      lastState = 'down';
      await alertOwner('The audio server is disconnected. The bot is still online and will keep retrying.');
      return;
    }
    try {
      await node.rest.getLavalinkInfo();
      if (lastState !== 'up') console.log('[lavalink] node is healthy');
      lastState = 'up';
    } catch (error) {
      console.error(`[lavalink] health check failed: ${error.message}`);
      if (lastState !== 'unhealthy') await alertOwner('The audio server failed a health check. Playback may be interrupted.');
      lastState = 'unhealthy';
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
      console.error(`[health] could not message the owner: ${error.message}`);
    }
  }

  return () => clearInterval(timer);
}

module.exports = { startHealth };
