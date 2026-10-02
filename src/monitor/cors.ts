/**
 * Tells a CORS rejection apart from an unreachable server after a request failed with status 0.
 *
 * A `no-cors` request is not subject to CORS checks: it resolves with an opaque response whenever
 * the server answers at all, and rejects only on network failure. HEAD keeps it from downloading
 * the body, so this never duplicates a segment or playlist download.
 *
 * @returns `true` if the server is reachable (so the original failure was CORS), `false` otherwise.
 */
export async function probeCors(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<boolean> {
  try {
    await fetchImpl(url, {
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return true
  } catch {
    return false
  }
}

/** An http:// stream on an https:// page is blocked by the browser before any request is made. */
export function isMixedContent(url: string, pageProtocol: string): boolean {
  try {
    return pageProtocol === 'https:' && new URL(url).protocol === 'http:'
  } catch {
    return false
  }
}
