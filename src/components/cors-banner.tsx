import { ShieldAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import type { SourceInfo } from '@/monitor/types'

/**
 * Explicit explanation for the failures a browser-only monitor can't work around: mixed content
 * and CORS. Shown for mixed content up front, and for fatal `cors` errors.
 */
export function CorsBanner({ source }: { source: SourceInfo }) {
  const fatal = source.fatal?.type === 'cors' ? source.fatal : undefined
  if (!source.mixedContent && !fatal) return null

  if (source.mixedContent) {
    return (
      <Alert variant="destructive">
        <ShieldAlert />
        <AlertTitle>Blocked: mixed content</AlertTitle>
        <AlertDescription>
          This page is served over HTTPS and the stream uses plain HTTP, so the browser blocks every request before it is
          sent. Use an https:// URL for the stream, or run the monitor over http:// (for example locally).
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert variant="destructive">
      <ShieldAlert />
      <AlertTitle>
        {fatal?.corsConfirmed === false ? 'Server unreachable (or CORS)' : 'Blocked by CORS'}
      </AlertTitle>
      <AlertDescription>
        {fatal?.corsConfirmed === undefined && <p>Checking whether the server is reachable…</p>}
        {fatal?.corsConfirmed === true && (
          <p>
            The server answered, but the browser hid the response because it lacks{' '}
            <code className="font-mono">Access-Control-Allow-Origin</code> for{' '}
            <code className="font-mono">{location.origin}</code>. The monitor runs entirely in the browser, so the CDN
            or origin must send CORS headers for playlists and segments.
          </p>
        )}
        {fatal?.corsConfirmed === false && (
          <p>
            The request got no response at all: the host may be down, the DNS name may not resolve, or a CORS preflight
            was rejected. Check the URL and that the server sends{' '}
            <code className="font-mono">Access-Control-Allow-Origin</code>.
          </p>
        )}
        {fatal?.url && <p className="font-mono text-xs break-all">{fatal.url}</p>}
      </AlertDescription>
    </Alert>
  )
}
