async function withRetry(work, { attempts = 3, baseMs = 400 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      const status = error.status;
      if (status === 401 || status === 403 || status === 404 || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, baseMs * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

module.exports = { withRetry };
