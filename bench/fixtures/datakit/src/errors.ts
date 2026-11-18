/** Error thrown by datakit for invalid arguments and malformed input. */
export class DatakitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatakitError';
  }
}
