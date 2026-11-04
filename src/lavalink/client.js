const { Shoukaku, Connectors } = require('shoukaku');

function createLavalink(client, config) {
  const shoukaku = new Shoukaku(
    new Connectors.DiscordJS(client),
    [{
      name: config.lavalink.name,
      url: `${config.lavalink.host}:${config.lavalink.port}`,
      auth: config.lavalink.password,
      secure: config.lavalink.secure,
    }],
    {
      resume: true,
      resumeTimeout: 60,
      resumeByLibrary: true,
      reconnectTries: Number.POSITIVE_INFINITY,
      reconnectInterval: 5,
      restTimeout: 15,
      moveOnDisconnect: false,
      voiceConnectionTimeout: 15,
    },
  );

  shoukaku.on('error', (name, error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[lavalink:${name}] ${message}`);
  });
  shoukaku.on('ready', (name) => {
    console.log(`[lavalink:${name}] connected`);
  });
  shoukaku.on('close', (name, code, reason) => {
    console.error(`[lavalink:${name}] connection closed (${code}${reason ? ` ${reason}` : ''})`);
  });
  shoukaku.on('disconnect', (name) => {
    console.error(`[lavalink:${name}] disconnected. Reconnecting.`);
  });
  shoukaku.on('reconnecting', (name) => {
    console.warn(`[lavalink:${name}] reconnecting`);
  });
  shoukaku.ensureConnected = () => {
    const name = config.lavalink.name;
    if (shoukaku.nodes.has(name)) return;
    shoukaku.addNode({
      name,
      url: `${config.lavalink.host}:${config.lavalink.port}`,
      auth: config.lavalink.password,
      secure: config.lavalink.secure,
    });
  };

  return shoukaku;
}

module.exports = { createLavalink };
