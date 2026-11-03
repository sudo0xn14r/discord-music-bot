function log(level, message, fields = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === '') continue;
    entry[key] = value;
  }
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else console.log(line);
}

module.exports = { log };
