class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
    this.userError = true;
  }
}

module.exports = { UserError };
