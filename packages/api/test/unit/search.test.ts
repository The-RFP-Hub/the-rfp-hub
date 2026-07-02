import { describe, expect, it } from "vitest";
import { escapeLike } from "../../src/modules/services/opportunities/opportunity.service.js";

describe("escapeLike", () => {
  it("escapes the % wildcard", () => {
    expect(escapeLike("100%")).toBe("100\\%");
  });

  it("escapes the _ wildcard", () => {
    expect(escapeLike("a_b")).toBe("a\\_b");
  });

  it("escapes the backslash escape char", () => {
    expect(escapeLike("c:\\path")).toBe("c:\\\\path");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeLike("defi grant")).toBe("defi grant");
  });
});
