import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authPost, authUrl } from "@/features/auth/providers/better-auth-api";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Better Auth client", () => {
  it("targets the merchant API, not the SPA origin", () => {
    expect(authUrl("/session")).toBe("https://api.test/api/auth/session");
  });

  it("sends credentials so the session cookie is set and sent", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await authPost("/sign-in/email", {
      email: "a@b.com",
      password: "password123",
    });

    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toBe("https://api.test/api/auth/sign-in/email"); // hyphenated Better Auth path
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body)).toEqual({
      email: "a@b.com",
      password: "password123",
    });
  });

  it("uses hyphenated sign-up path and throws the server message on failure", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "User already exists" }), {
        status: 422,
      }),
    );
    await expect(
      authPost("/sign-up/email", {
        name: "A",
        email: "a@b.com",
        password: "x",
      }),
    ).rejects.toThrow("User already exists");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.test/api/auth/sign-up/email",
    );
  });

  it("falls back to the HTTP status when the body has no message", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 500 }));
    await expect(authPost("/sign-out", {})).rejects.toThrow("HTTP 500");
  });
});
