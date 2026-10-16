/**
 * Base class for the project's named errors. `new.target.name` resolves to the
 * concrete subclass that was constructed, even when the instance is built via
 * `super()`, so each subclass keeps its own `name` without repeating the
 * assignment.
 */
export class NamedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}
