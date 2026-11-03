const fs = require('node:fs');
const path = require('node:path');
const { createTrack } = require('../music/track');
const { normalize, queryMatches, titlesMatch } = require('./match');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.ogg', '.opus', '.wav', '.m4a', '.aac']);

class LocalLibrary {
  constructor(options) {
    this.name = 'local';
    this.label = 'the local library';
    this.canPlay = true;
    this.root = options.localMusicDir;
    this.isEnabled = options.enabled !== false;
  }

  enabled() {
    return this.isEnabled;
  }

  async available() {
    if (!this.enabled()) return false;
    try {
      const stat = fs.statSync(this.root);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  status() {
    if (!this.enabled()) return 'disabled by PROVIDER_ORDER';
    return 'enabled';
  }

  rootReal() {
    return fs.realpathSync(this.root);
  }

  isInside(rootReal, candidate) {
    const real = fs.realpathSync(candidate);
    return real === rootReal || real.startsWith(rootReal + path.sep);
  }

  looksLikePath(input) {
    const value = String(input || '').trim();
    if (!value || value.includes('\0')) return false;
    if (value.startsWith('file://')) return true;
    if (path.isAbsolute(value)) return true;
    if (/^\.{1,2}[/\\]/.test(value)) return true;
    return AUDIO_EXTENSIONS.has(path.extname(value).toLowerCase());
  }

  resolveInputPath(input) {
    const value = String(input || '').trim();
    if (!value || value.includes('\0')) return null;
    if (value.startsWith('file://')) {
      try {
        return path.resolve(new URL(value).pathname);
      } catch {
        return null;
      }
    }
    return path.resolve(this.root, value);
  }

  owns(input) {
    if (!this.looksLikePath(input)) return false;
    const candidate = this.resolveInputPath(input);
    if (!candidate || !AUDIO_EXTENSIONS.has(path.extname(candidate).toLowerCase())) return false;
    let rootReal;
    try {
      rootReal = this.rootReal();
      if (!fs.statSync(candidate).isFile()) return false;
      return this.isInside(rootReal, candidate);
    } catch {
      return false;
    }
  }

  catalog() {
    let rootReal;
    try {
      rootReal = this.rootReal();
    } catch {
      return [];
    }
    const files = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile() || !AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        try {
          if (!this.isInside(rootReal, full)) continue;
          files.push(fs.realpathSync(full));
        } catch {
          // Skip files that disappear while scanning.
        }
      }
    };
    walk(rootReal);
    return files;
  }

  describeFile(filePath) {
    const base = path.basename(filePath, path.extname(filePath));
    const parts = base.split(/\s+-\s+/);
    if (parts.length >= 2 && parts[0].trim() && parts.slice(1).join('').trim()) {
      return {
        title: parts.slice(1).join(' - ').trim(),
        artist: parts[0].trim(),
        filePath,
      };
    }
    return { title: base.trim(), artist: '', filePath };
  }

  toTrack(described, requester) {
    return createTrack({
      title: described.title,
      artist: described.artist,
      source: 'local',
      requester,
      filePath: described.filePath,
    });
  }

  fileMatches(wanted, described) {
    if (titlesMatch(wanted, described)) return true;
    if (described.artist) return false;
    const blob = normalize(path.basename(described.filePath));
    const title = normalize(wanted.title);
    const artist = normalize(wanted.artist);
    if (title.length < 2 || artist.length < 2) return false;
    return blob.includes(title) && blob.includes(artist);
  }

  async search(query, limit = 1) {
    const ranked = this.catalog()
      .map((filePath) => this.describeFile(filePath))
      .filter((described) => queryMatches(query, described))
      .sort((left, right) => this.score(query, right) - this.score(query, left));
    return ranked.slice(0, limit).map((described) => this.toTrack(described));
  }

  score(query, described) {
    const wanted = normalize(query);
    const title = normalize(described.title);
    if (title === wanted) return 3;
    if (title.includes(wanted)) return 2;
    return 1;
  }

  async findMatch(metadata) {
    const files = this.catalog().map((filePath) => this.describeFile(filePath));
    const matches = files.filter((described) => this.fileMatches(metadata, described));
    matches.sort((left, right) => {
      const leftExact = normalize(left.title) === normalize(metadata.title) ? 0 : 1;
      const rightExact = normalize(right.title) === normalize(metadata.title) ? 0 : 1;
      return leftExact - rightExact;
    });
    const described = matches[0];
    if (!described) return null;
    if (!described.artist) {
      return this.toTrack({ ...described, title: metadata.title, artist: metadata.artist });
    }
    return this.toTrack(described);
  }

  async resolveUrl(input, requester) {
    if (!this.owns(input)) return { tracks: [], restricted: 0, truncated: false };
    const real = fs.realpathSync(this.resolveInputPath(input));
    return {
      tracks: [this.toTrack(this.describeFile(real), requester)],
      restricted: 0,
      truncated: false,
    };
  }

  async playbackIdentifier(track) {
    if (!track.filePath || !this.owns(track.filePath)) {
      const error = new Error('That file is no longer in the local music library.');
      error.userError = true;
      throw error;
    }
    return fs.realpathSync(track.filePath);
  }

  friendly(error) {
    return error?.userError ? error.message : 'The local library could not be read.';
  }
}

module.exports = { LocalLibrary, AUDIO_EXTENSIONS };
