import { describe, expect, it } from "vitest";

import {
  AVATAR_SOURCE_MAX_BYTES,
  checkAvatarFile,
  initialsOf,
  squareCrop,
} from "@/lib/avatar";

describe("profile picture helpers", () => {
  it("cuts the centred square", () => {
    expect(squareCrop(1200, 800)).toEqual({ sx: 200, sy: 0, side: 800 });
    expect(squareCrop(600, 900)).toEqual({ sx: 0, sy: 150, side: 600 });
    expect(squareCrop(512, 512)).toEqual({ sx: 0, sy: 0, side: 512 });
  });

  it("refuses non-images and huge files before decoding", () => {
    expect(checkAvatarFile({ type: "application/pdf", size: 10 })).toBe("type");
    expect(
      checkAvatarFile({
        type: "image/heic",
        size: AVATAR_SOURCE_MAX_BYTES + 1,
      }),
    ).toBe("size");
    expect(checkAvatarFile({ type: "image/heic", size: 3_000_000 })).toBeNull();
  });

  it("makes initials from the name, else the email", () => {
    expect(initialsOf("Ada  Lovelace Byron", "a@x.test")).toBe("AL");
    expect(initialsOf("", "zoe@x.test")).toBe("Z");
    expect(initialsOf(null, null)).toBe("?");
  });
});
