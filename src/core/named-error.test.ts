import { describe, expect, it } from "vitest";
import { NamedError } from "./named-error.js";

class WidgetError extends NamedError {}

describe("NamedError", () => {
  it("names a subclass instance after the subclass", () => {
    expect(new WidgetError("boom").name).toBe("WidgetError");
  });

  it("leaves a direct instance named after itself", () => {
    expect(new NamedError("boom").name).toBe("NamedError");
  });

  it("is an instance of the subclass and of NamedError", () => {
    const error = new WidgetError("boom");
    expect(error).toBeInstanceOf(WidgetError);
    expect(error).toBeInstanceOf(NamedError);
  });

  it("keeps the message and reaches the cause through options", () => {
    const cause = new Error("root");
    const error = new WidgetError("boom", { cause });
    expect(error.message).toBe("boom");
    expect(error.cause).toBe(cause);
  });
});
