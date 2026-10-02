/** Connectivity failures retry promptly when the local Anki application reopens. */
export class AnkiTransportError extends Error {
  override name = "AnkiTransportError"
}

/** A deliberately small, local-only AnkiConnect v6 transport. */
export interface AnkiClient {
  invoke: <T>(action: string, params?: Record<string, unknown>) => Promise<T>
}

export function validateAnkiEndpoint(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch (error) {
    throw new Error("Enter a valid local AnkiConnect URL", { cause: error })
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "AnkiConnect must use localhost, 127.0.0.1 or [::1], without credentials, query or path",
    )
  }
  return url.origin
}

export function createAnkiClient(
  endpoint: string,
  fetcher: typeof fetch = globalThis.fetch,
  timeoutMs = 15_000,
): AnkiClient {
  const url = validateAnkiEndpoint(endpoint)
  return {
    async invoke<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetcher(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, version: 6, params }),
          signal: controller.signal,
          // Never forward card data through a redirect away from loopback.
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
        })
        if (!response.ok) throw new AnkiTransportError(`AnkiConnect HTTP ${response.status}`)
        const payload: unknown = await response.json()
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("result" in payload) ||
          !("error" in payload)
        )
          throw new Error("Invalid AnkiConnect response")
        if (payload.error !== null) {
          throw new Error(
            typeof payload.error === "string" ? payload.error : "AnkiConnect request failed",
          )
        }
        return payload.result as T
      } catch (error) {
        if (controller.signal.aborted) {
          throw new AnkiTransportError(
            "AnkiConnect timed out. The queue will check whether the note was saved before retrying.",
            { cause: error },
          )
        }
        if (error instanceof TypeError) {
          throw new AnkiTransportError(
            "Cannot reach local AnkiConnect. Keep Anki open with AnkiConnect enabled.",
            { cause: error },
          )
        }
        throw error
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
