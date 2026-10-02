import { describe, expect, it, vi } from "vitest"
import { createAnkiClient, validateAnkiEndpoint } from "../client"

describe("AnkiConnect local transport", () => {
  it.each([
    "http://evil.test:8765",
    "http://localhost.evil.test:8765",
    "http://localhost:8765/a",
    "http://user:secret@localhost:8765",
    "file:///etc/passwd",
    "http://127.0.0.1:8765/?secret=1",
  ])("rejects non-local or credential-bearing endpoint %s", (url) => {
    expect(() => validateAnkiEndpoint(url)).toThrow(/AnkiConnect/)
  })
  it.each(["http://localhost:8765", "http://127.0.0.1:8765", "http://[::1]:8765"])(
    "accepts loopback %s",
    (url) => {
      expect(validateAnkiEndpoint(url)).toBe(url)
    },
  )
  it("sends v6 without cookies and rejects redirects", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ result: ["Default"], error: null })),
    )
    const client = createAnkiClient("http://localhost:8765", fetcher)
    expect(await client.invoke("deckNames")).toEqual(["Default"])
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:8765",
      expect.objectContaining({
        redirect: "error",
        credentials: "omit",
        body: JSON.stringify({ action: "deckNames", version: 6, params: {} }),
      }),
    )
  })
  it("does not accept malformed or error responses as success", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ result: null, error: "Anki is locked" })),
    )
    await expect(
      createAnkiClient("http://localhost:8765", fetcher).invoke("addNote"),
    ).rejects.toThrow("Anki is locked")
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ result: 42 })))
    await expect(
      createAnkiClient("http://localhost:8765", fetcher).invoke("addNote"),
    ).rejects.toThrow("Invalid")
  })
})
