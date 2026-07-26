const DEFAULT_MAX_LOCKFILE_BYTES = 50 * 1024 * 1024;
const COMMIT_ID = /^[0-9a-f]{40,64}$/iu;

export interface GitHubContentsRequest {
  owner: string;
  repo: string;
  path: string;
  ref: string;
}

export interface GitHubContentsResponse {
  status: number;
  data: unknown;
}

/** Narrow adapter so the retriever is testable without constructing Octokit. */
export interface GitHubContentsClient {
  getContent(
    request: GitHubContentsRequest,
    mediaType: "object" | "raw",
  ): Promise<GitHubContentsResponse>;
}

export interface BaseLockfileRequest extends GitHubContentsRequest {
  maxBytes?: number;
}

export type BaseLockfileResult =
  | { status: "found"; ref: string; text: string }
  | { status: "missing"; ref: string };

export class GitHubContentsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class GitHubContentsConfigurationError extends GitHubContentsError {}

export class GitHubContentsApiError extends GitHubContentsError {
  constructor(
    message: string,
    readonly status: number | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class GitHubContentsContractError extends GitHubContentsError {}

/**
 * Reads one regular lockfile at an immutable commit through the Contents API.
 * Only a genuine 404 is first-run absence; every other failure is loud.
 */
export async function retrieveBaseLockfile(
  request: BaseLockfileRequest,
  client: GitHubContentsClient,
): Promise<BaseLockfileResult> {
  validateRequest(request);
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_LOCKFILE_BYTES;

  const metadata = await requestContent(client, request, "object");
  if (metadata.status === 404) return { status: "missing", ref: request.ref };
  requireSuccess(metadata.status, "inspect", request.path);

  const file = parseFileMetadata(metadata.data, maxBytes);
  let bytes: Uint8Array;
  if (file.encoding === "base64") {
    bytes = decodeBase64(file.content);
  } else {
    const raw = await requestContent(client, request, "raw");
    requireSuccess(raw.status, "read", request.path);
    bytes = parseRawBytes(raw.data);
  }

  if (bytes.byteLength > maxBytes) {
    throw new GitHubContentsContractError(
      `base lockfile exceeds the ${String(maxBytes)} byte limit`,
    );
  }

  try {
    return {
      status: "found",
      ref: request.ref,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch (error: unknown) {
    throw new GitHubContentsContractError("base lockfile is not valid UTF-8", {
      cause: error,
    });
  }
}

function validateRequest(request: BaseLockfileRequest): void {
  for (const [field, value] of [
    ["owner", request.owner],
    ["repo", request.repo],
  ] as const) {
    if (value.length === 0) {
      throw new GitHubContentsConfigurationError(`${field} must not be empty`);
    }
  }
  if (!COMMIT_ID.test(request.ref)) {
    throw new GitHubContentsConfigurationError(
      "ref must be an immutable full commit ID",
    );
  }
  if (
    request.path.length === 0 ||
    request.path.startsWith("/") ||
    request.path.includes("\\") ||
    request.path.includes("\0") ||
    request.path
      .split("/")
      .some((segment) => segment === ".." || segment === "")
  ) {
    throw new GitHubContentsConfigurationError(
      "lockfile path must be a normalized relative POSIX path",
    );
  }
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_LOCKFILE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new GitHubContentsConfigurationError(
      "maxBytes must be a positive safe integer",
    );
  }
}

async function requestContent(
  client: GitHubContentsClient,
  request: GitHubContentsRequest,
  mediaType: "object" | "raw",
): Promise<GitHubContentsResponse> {
  try {
    return await client.getContent(request, mediaType);
  } catch (error: unknown) {
    const status = statusFrom(error);
    if (status === 404) return { status, data: null };
    throw new GitHubContentsApiError(
      `GitHub Contents API failed while ${mediaType === "object" ? "inspecting" : "reading"} the base lockfile`,
      status,
      { cause: error },
    );
  }
}

function statusFrom(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  return typeof error.status === "number" ? error.status : null;
}

function requireSuccess(status: number, operation: string, path: string): void {
  if (status >= 200 && status < 300) return;
  throw new GitHubContentsApiError(
    `GitHub Contents API returned ${String(status)} while attempting to ${operation} ${JSON.stringify(path)}`,
    status,
  );
}

interface FileMetadata {
  encoding: "base64" | "raw";
  content: string;
}

function parseFileMetadata(data: unknown, maxBytes: number): FileMetadata {
  if (!isRecord(data) || data.type !== "file") {
    throw new GitHubContentsContractError(
      "GitHub Contents API response is not a regular file",
    );
  }
  if (!Number.isSafeInteger(data.size) || (data.size as number) < 0) {
    throw new GitHubContentsContractError(
      "GitHub Contents API response has an invalid file size",
    );
  }
  if ((data.size as number) > maxBytes) {
    throw new GitHubContentsContractError(
      `base lockfile exceeds the ${String(maxBytes)} byte limit`,
    );
  }
  if (data.encoding === "base64" && typeof data.content === "string") {
    return { encoding: "base64", content: data.content };
  }
  if (
    (data.encoding === "none" || data.encoding === "") &&
    (data.content === "" || data.content === undefined)
  ) {
    return { encoding: "raw", content: "" };
  }
  throw new GitHubContentsContractError(
    "GitHub Contents API response has an unsupported content encoding",
  );
}

function decodeBase64(content: string): Uint8Array {
  const compact = content.replaceAll("\n", "");
  if (
    compact.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      compact,
    )
  ) {
    throw new GitHubContentsContractError(
      "GitHub Contents API returned invalid base64 content",
    );
  }
  return Buffer.from(compact, "base64");
}

function parseRawBytes(data: unknown): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new GitHubContentsContractError(
    "GitHub Contents API returned an invalid raw response",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
