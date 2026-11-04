const { log } = require('../util/log');

function bindPlayerEvents(player, session) {
  if (player.boundGuildPlayback) return;
  player.boundGuildPlayback = true;

  player.on('end', (event) => {
    if (event.reason === 'finished' || event.reason === 'loadFailed') {
      session.finishListen({ completed: event.reason === 'finished' });
    }
    const started = session.playGeneration;
    session.enqueue(async () => {
      if (session.starting || session.leaving) return;
      if (started === -1 || session.playGeneration !== started) return;
      if (event.reason !== 'finished' && event.reason !== 'loadFailed') return;
      session.playGeneration = -1;
      await session.advanceAfter(event.reason);
    });
  });

  player.on('exception', (event) => {
    log('error', 'playback failed', {
      guildId: session.guildId,
      source: session.queue.current?.source,
      error: event?.exception?.message || 'unknown playback error',
      node: session.manager.lavalink?.getIdealNode?.()?.name,
    });
  });

  player.on('stuck', () => {
    log('error', 'playback failed', {
      guildId: session.guildId,
      source: session.queue.current?.source,
      error: 'track stuck',
      node: session.manager.lavalink?.getIdealNode?.()?.name,
    });
    session.enqueue(async () => {
      if (session.leaving) return;
      const failed = session.queue.current;
      session.playGeneration = -1;
      session.generation += 1;
      try {
        await player.stopTrack();
      } catch (error) {
        log('error', 'playback failed', {
          guildId: session.guildId,
          source: failed?.source,
          error: error.message,
          node: session.manager.lavalink?.getIdealNode?.()?.name,
        });
      }
      session.queue.shiftNext();
      const outcome = await session.playCurrent(session.generation);
      const note = failed ? `Couldn't play **${session.displayTitle(failed)}**: that track got stuck.` : 'That track got stuck.';
      const extra = [note, ...session.skippedNotes(outcome)].filter(Boolean).join('\n');
      await session.refreshPanel(session.queue.current ? extra : `${extra}\nThe queue has finished.`);
    });
  });

  player.on('update', (data) => {
    if (typeof data?.state?.position === 'number') session.notePosition(data.state.position);
  });

  player.on('start', (event) => {
    session.positionMs = session.pendingSeekMs || 0;
    session.pendingSeekMs = 0;
    const length = event?.track?.info?.length;
    if (session.queue.current && Number.isFinite(length) && length > 0) {
      session.queue.current.durationMs = length;
    }
    if (session.queue.current) {
      session.manager.database.addHistory(session.guildId, session.queue.current);
      session.beginListen(session.queue.current);
    }
  });

  player.on('closed', (event) => {
    log('error', 'voice closed', {
      guildId: session.guildId,
      source: session.queue.current?.source,
      error: `${event?.code ?? 'unknown'}${event?.reason ? ` ${event.reason}` : ''}`,
      node: session.manager.lavalink?.getIdealNode?.()?.name,
    });
  });
}

module.exports = { bindPlayerEvents };
