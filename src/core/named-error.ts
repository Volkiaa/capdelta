// new.target is the class passed to `new`, so subclasses inherit the right name.
export class NamedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}
