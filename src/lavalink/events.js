function bindPlayerEvents(player, session) {
  if (player.boundGuildPlayback) return;
  player.boundGuildPlayback = true;

  player.on('end', (event) => {
    const started = session.playGeneration;
    session.enqueue(async () => {
      if (session.starting || session.leaving) return;
      if (started === -1 || session.playGeneration !== started) return;
      if (event.reason !== 'finished' && event.reason !== 'loadFailed') return;
      session.playGeneration = -1;
      const failed = event.reason === 'loadFailed' ? session.queue.current : null;
      if (failed) {
        console.error(`[player:${session.guildId}] load failed for ${failed.title}`);
      }
      session.queue.shiftNext();
      const outcome = await session.playCurrent(session.generation);
      const notes = [];
      if (failed) notes.push(`Couldn't play **${session.displayTitle(failed)}**: that audio is unavailable.`);
      notes.push(...session.skippedNotes(outcome));
      if (!session.queue.current) notes.push('The queue has finished.');
      await session.refreshPanel(notes.filter(Boolean).join('\n') || null);
    });
  });

  player.on('exception', (event) => {
    const message = event?.exception?.message || 'unknown playback error';
    console.error(`[player:${session.guildId}] track exception: ${message}`);
  });

  player.on('stuck', () => {
    console.error(`[player:${session.guildId}] track stuck`);
    session.enqueue(async () => {
      if (session.leaving) return;
      const failed = session.queue.current;
      session.playGeneration = -1;
      session.generation += 1;
      try {
        await player.stopTrack();
      } catch (error) {
        console.error(`[player:${session.guildId}] stop after stuck failed: ${error.message}`);
      }
      session.queue.shiftNext();
      const outcome = await session.playCurrent(session.generation);
      const note = failed ? `Couldn't play **${session.displayTitle(failed)}**: that track got stuck.` : 'That track got stuck.';
      const extra = [note, ...session.skippedNotes(outcome)].filter(Boolean).join('\n');
      await session.refreshPanel(session.queue.current ? extra : `${extra}\nThe queue has finished.`);
    });
  });

  player.on('update', (data) => {
    if (typeof data?.state?.position === 'number') session.positionMs = data.state.position;
  });

  player.on('start', (event) => {
    session.positionMs = 0;
    const length = event?.track?.info?.length;
    if (session.queue.current && Number.isFinite(length) && length > 0) {
      session.queue.current.durationMs = length;
    }
    if (session.queue.current) session.manager.database.addHistory(session.guildId, session.queue.current);
  });

  player.on('closed', (event) => {
    const reason = event?.reason ? ` ${event.reason}` : '';
    console.error(`[player:${session.guildId}] voice closed (${event?.code ?? 'unknown'}${reason})`);
  });
}

module.exports = { bindPlayerEvents };
