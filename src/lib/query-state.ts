/** `auto` = ABR enabled; a number = forced index into `hls.levels`. */
export type VariantSelection = number | 'auto'

export interface QueryState {
  url: string | null
  variant: VariantSelection
}

export function parseQueryState(search: string): QueryState {
  const params = new URLSearchParams(search)
  const url = params.get('url')?.trim() || null
  const raw = params.get('variant')
  const index = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN
  return { url, variant: Number.isSafeInteger(index) ? index : 'auto' }
}

/**
 * Returns `search` with `url` and `variant` replaced by `state`, keeping any other params.
 * `variant=auto` and a null url are omitted to keep shared links short.
 */
export function serializeQueryState(state: QueryState, search = ''): string {
  const params = new URLSearchParams(search)
  if (state.url) params.set('url', state.url)
  else params.delete('url')
  if (state.variant === 'auto') params.delete('variant')
  else params.set('variant', String(state.variant))
  const out = params.toString()
  return out ? `?${out}` : ''
}
