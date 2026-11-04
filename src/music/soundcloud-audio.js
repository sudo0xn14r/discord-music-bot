const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let server = null;
let port = 0;
let starting = null;
let transcoder = null;
const streams = new Map();

function userError(message) {
  const error = new Error(message);
  error.userError = true;
  return error;
}

function soundCloudPlaybackPage(track) {
  const value = String(track?.pageUrl || track?.identifier || '').trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  if (host !== 'soundcloud.com' || parts.length < 2) return '';
  return url.toString();
}

function setSoundCloudTranscoder(fn) {
  transcoder = fn;
}

function ffmpegAvailable() {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], (error) => resolve(!error));
  });
}

function startTranscode(mediaUrl) {
  if (transcoder) return transcoder(mediaUrl);
  return spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-user_agent', USER_AGENT,
    '-headers', 'Referer: https://soundcloud.com/\r\nOrigin: https://soundcloud.com\r\n',
    '-i', mediaUrl,
    '-vn',
    '-acodec', 'libmp3lame',
    '-b:a', '192k',
    '-ar', '48000',
    '-ac', '2',
    '-f', 'mp3',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function ensureServer() {
  if (server) return Promise.resolve(port);
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    const created = http.createServer((req, res) => {
      const token = String(req.url || '').split('?')[0].replace(/^\/sc\//, '');
      const entry = streams.get(token);
      if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end();
        return;
      }
      const child = startTranscode(entry.mediaUrl);
      let closed = false;
      const stop = () => {
        if (closed) return;
        closed = true;
        child.kill('SIGKILL');
      };
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      child.stdout.pipe(res);
      child.stderr.on('data', () => {});
      child.on('error', stop);
      child.on('exit', () => {
        if (!res.writableEnded) res.end();
      });
      res.on('close', stop);
    });
    created.once('error', reject);
    created.listen(0, '127.0.0.1', () => {
      created.unref();
      server = created;
      port = created.address().port;
      starting = null;
      resolve(port);
    });
  });
  return starting;
}

async function openSoundCloudStream(mediaUrl) {
  if (!transcoder && !(await ffmpegAvailable())) {
    throw userError('SoundCloud audio needs ffmpeg. Install it on the server and try again.');
  }
  const listenPort = await ensureServer();
  const token = crypto.randomBytes(18).toString('hex');
  streams.set(token, { mediaUrl, created: Date.now() });
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [key, entry] of streams) {
    if (entry.created < cutoff) streams.delete(key);
  }
  return `http://127.0.0.1:${listenPort}/sc/${token}`;
}

module.exports = {
  openSoundCloudStream,
  setSoundCloudTranscoder,
  soundCloudPlaybackPage,
};
