import { describe, expect, it, vi } from "vitest";
import {
  GitHubContentsApiError,
  GitHubContentsConfigurationError,
  GitHubContentsContractError,
  retrieveBaseLockfile,
  type GitHubContentsClient,
  type GitHubContentsResponse,
} from "./base-lockfile-retriever.js";

const REF = "a".repeat(40);

function clientWith(
  ...responses: readonly GitHubContentsResponse[]
): GitHubContentsClient & { getContent: ReturnType<typeof vi.fn> } {
  const getContent = vi.fn();
  for (const response of responses) getContent.mockResolvedValueOnce(response);
  return { getContent };
}

function encoded(text: string): GitHubContentsResponse {
  return {
    status: 200,
    data: {
      type: "file",
      size: Buffer.byteLength(text),
      encoding: "base64",
      content: Buffer.from(text).toString("base64"),
    },
  };
}

describe("retrieveBaseLockfile", () => {
  it("decodes a regular file from an exact commit", async () => {
    const client = clientWith(encoded('{"lockfileVersion":3}\n'));

    await expect(
      retrieveBaseLockfile(
        { owner: "owner", repo: "repo", path: "package-lock.json", ref: REF },
        client,
      ),
    ).resolves.toEqual({
      status: "found",
      ref: REF,
      text: '{"lockfileVersion":3}\n',
    });
    expect(client.getContent).toHaveBeenCalledWith(
      { owner: "owner", repo: "repo", path: "package-lock.json", ref: REF },
      "object",
    );
  });

  it("treats only a 404 as first-run absence", async () => {
    const missing = clientWith({ status: 404, data: { message: "missing" } });
    await expect(
      retrieveBaseLockfile(
        { owner: "o", repo: "r", path: "package-lock.json", ref: REF },
        missing,
      ),
    ).resolves.toEqual({ status: "missing", ref: REF });

    const forbidden = clientWith({ status: 403, data: { message: "no" } });
    await expect(
      retrieveBaseLockfile(
        { owner: "o", repo: "r", path: "package-lock.json", ref: REF },
        forbidden,
      ),
    ).rejects.toMatchObject(GitHubContentsApiError.prototype);
  });

  it("recognizes a thrown 404 but contextualizes other thrown API errors", async () => {
    const missing: GitHubContentsClient = {
      getContent: vi.fn().mockRejectedValue({ status: 404 }),
    };
    await expect(
      retrieveBaseLockfile(
        { owner: "o", repo: "r", path: "package-lock.json", ref: REF },
        missing,
      ),
    ).resolves.toEqual({ status: "missing", ref: REF });

    const cause = Object.assign(new Error("rate limited"), { status: 429 });
    const limited: GitHubContentsClient = {
      getContent: vi.fn().mockRejectedValue(cause),
    };
    await expect(
      retrieveBaseLockfile(
        { owner: "o", repo: "r", path: "package-lock.json", ref: REF },
        limited,
      ),
    ).rejects.toMatchObject({
      name: "GitHubContentsApiError",
      status: 429,
      cause,
    });
  });

  it("uses raw media for a valid large-file metadata response", async () => {
    const client = clientWith(
      {
        status: 200,
        data: { type: "file", size: 4, encoding: "none", content: "" },
      },
      { status: 200, data: new TextEncoder().encode("test") },
    );
    await expect(
      retrieveBaseLockfile(
        { owner: "o", repo: "r", path: "nested/package-lock.json", ref: REF },
        client,
      ),
    ).resolves.toMatchObject({ status: "found", text: "test" });
    expect(client.getContent).toHaveBeenNthCalledWith(
      2,
      { owner: "o", repo: "r", path: "nested/package-lock.json", ref: REF },
      "raw",
    );
  });

  it("rejects unsafe paths and mutable refs before calling GitHub", async () => {
    const client = clientWith();
    for (const path of [
      "",
      "/package-lock.json",
      "../package-lock.json",
      "a\\b",
      "a//b",
    ]) {
      await expect(
        retrieveBaseLockfile({ owner: "o", repo: "r", path, ref: REF }, client),
      ).rejects.toBeInstanceOf(GitHubContentsConfigurationError);
    }
    await expect(
      retrieveBaseLockfile(
        { owner: "o", repo: "r", path: "package-lock.json", ref: "main" },
        client,
      ),
    ).rejects.toBeInstanceOf(GitHubContentsConfigurationError);
    expect(client.getContent).not.toHaveBeenCalled();
  });

  it("rejects non-files, invalid encodings, oversized data, and invalid UTF-8", async () => {
    const requests = {
      owner: "o",
      repo: "r",
      path: "package-lock.json",
      ref: REF,
    };
    await expect(
      retrieveBaseLockfile(
        { ...requests, maxBytes: 3 },
        clientWith(encoded("four")),
      ),
    ).rejects.toBeInstanceOf(GitHubContentsContractError);
    await expect(
      retrieveBaseLockfile(requests, clientWith({ status: 200, data: [] })),
    ).rejects.toBeInstanceOf(GitHubContentsContractError);
    await expect(
      retrieveBaseLockfile(
        requests,
        clientWith({
          status: 200,
          data: { type: "file", size: 1, encoding: "base64", content: "?" },
        }),
      ),
    ).rejects.toBeInstanceOf(GitHubContentsContractError);
    await expect(
      retrieveBaseLockfile(
        requests,
        clientWith({
          status: 200,
          data: {
            type: "file",
            size: 2,
            encoding: "base64",
            content: Buffer.from([0xc3, 0x28]).toString("base64"),
          },
        }),
      ),
    ).rejects.toThrow("not valid UTF-8");
  });
});
