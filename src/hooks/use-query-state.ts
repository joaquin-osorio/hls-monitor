import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { parseQueryState, type QueryState, serializeQueryState } from '@/lib/query-state'

const CHANGE_EVENT = 'querystatechange'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(CHANGE_EVENT, onChange)
  }
}

const getSearch = () => window.location.search

/**
 * `?url=&variant=` as React state. The URL is the source of truth: back/forward navigation
 * updates the state. `push` adds a history entry (new stream), `replace` doesn't (variant change).
 */
export function useQueryState(): [QueryState, (next: Partial<QueryState>, mode?: 'push' | 'replace') => void] {
  const search = useSyncExternalStore(subscribe, getSearch)
  const state = useMemo(() => parseQueryState(search), [search])

  const setState = useCallback((next: Partial<QueryState>, mode: 'push' | 'replace' = 'replace') => {
    const current = parseQueryState(window.location.search)
    const query = serializeQueryState({ ...current, ...next }, window.location.search)
    const href = `${window.location.pathname}${query}${window.location.hash}`
    if (mode === 'push') window.history.pushState(null, '', href)
    else window.history.replaceState(null, '', href)
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }, [])

  return [state, setState]
}
