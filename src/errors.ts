export class UserFacingError extends Error {
  public override readonly name = "UserFacingError";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
