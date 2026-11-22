import { describe, expect, it } from "vitest";

import { adminAccess, loginRedirect } from "@/features/auth/admin-access";

describe("adminAccess", () => {
  it("waits while the session is loading", () => {
    expect(
      adminAccess({ isLoading: true, isAuthenticated: false, user: null }),
    ).toBe("loading");
  });

  it("sends signed-out visitors to login", () => {
    expect(
      adminAccess({ isLoading: false, isAuthenticated: false, user: null }),
    ).toBe("login");
  });

  it("forbids signed-in users who are not admins (email not in ADMIN_EMAILS)", () => {
    expect(
      adminAccess({
        isLoading: false,
        isAuthenticated: true,
        user: { email: "c@x.com", is_admin: false },
      }),
    ).toBe("forbidden");
    // missing flag is treated as not-admin
    expect(
      adminAccess({
        isLoading: false,
        isAuthenticated: true,
        user: { email: "c@x.com" },
      }),
    ).toBe("forbidden");
  });

  it("allows admins", () => {
    expect(
      adminAccess({
        isLoading: false,
        isAuthenticated: true,
        user: { email: "boss@x.com", is_admin: true },
      }),
    ).toBe("allowed");
  });
});

describe("loginRedirect", () => {
  it("encodes the return path", () => {
    expect(loginRedirect("/admin/orders?status=paid")).toBe(
      "/login?returnTo=%2Fadmin%2Forders%3Fstatus%3Dpaid",
    );
  });
});
