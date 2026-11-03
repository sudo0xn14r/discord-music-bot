const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDatabase(filePath) {
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      volume INTEGER NOT NULL DEFAULT 100,
      text_channel_id TEXT
    );
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (guild_id, name)
    );
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      duration_ms INTEGER,
      source TEXT NOT NULL,
      page_url TEXT,
      file_path TEXT,
      soundcloud_id TEXT,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT,
      source TEXT,
      page_url TEXT,
      requester TEXT,
      played_at INTEGER NOT NULL
    );
  `);
  return new BotDatabase(db);
}

class BotDatabase {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  getGuild(guildId) {
    const row = this.db.prepare(
      'SELECT volume, text_channel_id AS textChannelId FROM guild_settings WHERE guild_id = ?',
    ).get(guildId);
    return row ? { volume: row.volume, textChannelId: row.textChannelId } : null;
  }

  setVolume(guildId, volume) {
    this.db.prepare(`
      INSERT INTO guild_settings (guild_id, volume) VALUES (?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET volume = excluded.volume
    `).run(guildId, volume);
  }

  setTextChannel(guildId, channelId) {
    this.db.prepare(`
      INSERT INTO guild_settings (guild_id, volume, text_channel_id) VALUES (?, 100, ?)
      ON CONFLICT(guild_id) DO UPDATE SET text_channel_id = excluded.text_channel_id
    `).run(guildId, channelId);
  }

  addHistory(guildId, track) {
    this.db.prepare(`
      INSERT INTO history (guild_id, title, artist, source, page_url, requester, played_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      guildId,
      track.title,
      track.artist,
      track.source,
      track.pageUrl,
      track.requester,
      Date.now(),
    );
    this.db.prepare(`
      DELETE FROM history
      WHERE guild_id = ?
        AND id NOT IN (
          SELECT id FROM history WHERE guild_id = ? ORDER BY played_at DESC, id DESC LIMIT 100
        )
    `).run(guildId, guildId);
  }

  recentHistory(guildId, limit = 10) {
    return this.db.prepare(`
      SELECT title, artist, source, page_url AS pageUrl, requester, played_at AS playedAt
      FROM history
      WHERE guild_id = ?
      ORDER BY played_at DESC, id DESC
      LIMIT ?
    `).all(guildId, limit);
  }

  listPlaylists(guildId) {
    return this.db.prepare(`
      SELECT name, created_by AS createdBy, created_at AS createdAt,
        (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = playlists.id) AS tracks
      FROM playlists
      WHERE guild_id = ?
      ORDER BY name COLLATE NOCASE
    `).all(guildId);
  }

  getPlaylist(guildId, name) {
    return this.db.prepare(
      'SELECT id, name FROM playlists WHERE guild_id = ? AND name = ? COLLATE NOCASE',
    ).get(guildId, name) || null;
  }

  loadPlaylist(guildId, name) {
    const playlist = this.getPlaylist(guildId, name);
    if (!playlist) return null;
    const tracks = this.db.prepare(`
      SELECT title, artist, album, duration_ms AS durationMs, source,
        page_url AS pageUrl, file_path AS filePath, soundcloud_id AS soundcloudId
      FROM playlist_tracks
      WHERE playlist_id = ?
      ORDER BY position ASC, id ASC
    `).all(playlist.id);
    return { name: playlist.name, tracks };
  }

  savePlaylist(guildId, name, tracks, createdBy) {
    this.db.exec('BEGIN');
    try {
      const existing = this.getPlaylist(guildId, name);
      let playlistId;
      if (existing) {
        playlistId = existing.id;
        this.db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlistId);
      } else {
        const inserted = this.db.prepare(
          'INSERT INTO playlists (guild_id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
        ).run(guildId, name, createdBy, Date.now());
        playlistId = Number(inserted.lastInsertRowid);
      }
      const insert = this.db.prepare(`
        INSERT INTO playlist_tracks (
          playlist_id, position, title, artist, album, duration_ms, source, page_url, file_path, soundcloud_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      tracks.forEach((track, index) => {
        insert.run(
          playlistId,
          index,
          track.title,
          track.artist,
          track.album,
          track.durationMs,
          track.source,
          track.pageUrl,
          track.filePath,
          track.soundcloudId,
        );
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deletePlaylist(guildId, name) {
    const existing = this.getPlaylist(guildId, name);
    if (!existing) return false;
    this.db.prepare('DELETE FROM playlists WHERE id = ?').run(existing.id);
    return true;
  }
}

module.exports = { openDatabase, BotDatabase };
