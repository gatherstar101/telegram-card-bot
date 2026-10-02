export class Failure extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
