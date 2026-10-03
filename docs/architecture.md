# Architecture

HLS Monitor is a browser-only SPA. Everything, including the monitoring engine, runs in the page
(plus one Web Worker). There is no backend, so any stream must be reachable from the browser with
CORS headers.

## Layers

```
src/monitor/        engine: plain TypeScript, no React. Unit-tested in Node.
src/lib/            small shared utilities (query-string state, cn)
src/hooks/          React bindings for the engine and the URL state
src/components/     panels (src/components/ui/ is shadcn, vendored)
```

`MonitorSession` (`src/monitor/session.ts`) is the only place where hls.js, the `<video>` element
and the collectors meet. React creates one session per URL and subscribes to `session.store`
with `useSyncExternalStore`.

## Data flow

```
hls.js ──requests──▶ MonitoringLoader (wraps Hls.DefaultConfig.loader)
                        │ onRequest(record)        → SegmentLog (fragments)
                        │ onPlaylist(record, text) → parsePlaylist → PlaylistHealthTracker, checks, gaps
                        │ onTsSegment(record, copy)→ TsAnalyzer (worker) → SegmentLog.attachAnalysis, codec checks
hls.js ──events────▶ ERROR → classifyHlsError → errors (+ CORS probe)
                     MANIFEST_PARSED / LEVEL_SWITCHING / LEVEL_SWITCHED → variants, selection
<video> ──events───▶ waiting / playing / seeking → stalls; error → decode errors
setInterval(500ms) ─▶ buffer ahead, live-edge distance, PDT latency, frame counters; loudness chart point
AudioWorklet ──100 ms blocks──▶ LoudnessMeter (only while enabled)
                        │
                        ▼ markDirty(slice)
                  ThrottledStore ──(≤ 1 flush / 500 ms, inside rAF)──▶ MonitorSnapshot ──▶ React
```

## Invariants

- **No duplicate downloads.** The monitor never re-downloads anything hls.js fetched: it observes
  hls.js through the loader wrapper. Its only own requests are the CORS probe (below, a body-less
  `HEAD`) and the variant alignment probe (below): media playlists only, **never segments**.
- **No segment bytes are retained.** For MPEG-TS fragments the loader copies the bytes
  synchronously in `onSuccess`, before calling hls.js back. This is required because hls.js may
  transfer (detach) the original buffer to its transmux worker. The copy is transferred, not
  cloned, to the TS worker and dropped after parsing. When the worker has `MAX_IN_FLIGHT` jobs, new
  segments are skipped before copying. fMP4 and encrypted (AES-128) segments fail the TS sniff and
  are never copied.
- **Bounded memory.** Every time series lives in a `TimeWindowBuffer`, which keeps the last 30
  minutes (`RETENTION_MS`) and also has a hard capacity. Findings are deduplicated by key, so they
  stay bounded too.
- **Render throttle.** Collectors only call `store.markDirty(slice)`. The store rebuilds dirty
  slices at most every 500 ms inside `requestAnimationFrame`, and leaves clean slices
  referentially equal. In a hidden tab, rAF pauses, so the UI stops refreshing while collection
  keeps going.
- **Clocks.**
  - Durations and timestamps use `performance.now()`. hls.js `LoaderStats` already use it, so
    loader timings and session timestamps share one clock. To display wall-clock time, use
    `performance.timeOrigin + t`.
  - Only the PROGRAM-DATE-TIME latency uses `Date.now()`, because PDT is wall-clock. That number
    is only as accurate as the client clock.

## Segment inspector

The inspector (`segment-inspector.tsx`) reads one `SegmentRecord` live from the snapshot by key,
so it keeps updating while open (a retry or a late TS analysis shows up) and says so when the
record leaves the retention window. Its selection is scoped to the URL it was opened for.

Response headers are captured by the loader from `networkDetails` (the XHR for hls.js's default
loader, the `Response` for its fetch loader), for fragments only, latest attempt only. Browsers
only expose CORS-safelisted headers on cross-origin responses, plus what the server lists in
`Access-Control-Expose-Headers`, so CDN headers such as `Age` or `X-Cache` are usually missing.

## Why a custom playlist parser

hls.js parses playlists too, but it normalizes and tolerates spec violations: it accepts EXTINF
above the target, fixes up dates, and drops some tags. The monitor must report what the server
actually sent, so `playlist/parse.ts` re-parses the raw text the loader already has. It parses
only the tags the checks need, and it is not used for playback.

## Playlist identity

Health is tracked per role, not per URL: `main:<level>`, `audio:<id>`, `subtitle:<id>`. URLs can
change between refreshes of the same playlist (LL-HLS delivery directives, token rotation). A
media playlist given directly as the source is `main:0`.

hls.js only refreshes the active level. On `LEVEL_SWITCHING` the session calls `forget` on the
previous level, so that returning to it later does not register as segments missed between
refreshes.

## Network simulation (`network-shaper.ts`)

A browser page can't throttle its own sockets, so throttling is simulated inside the loader
wrapper, after the real response arrived at full speed:

- `NetworkShaper` models one downlink shared by all hls.js requests: latency is added before
  the first byte, and a body only starts flowing once the previous one finished (`busyUntil`),
  so concurrent audio/video/playlist loads compete for bandwidth.
- The wrapper holds the response until its simulated end and rewrites `LoaderStats` in place
  (`loading.first/end`, `bwEstimate`). hls.js reads the same object (`frag.stats =
  loader.stats`), so its bandwidth estimate and ABR follow the simulated link.
- While held, `stats.loaded` and `loading.first` advance to the simulated progress every 100 ms.
  hls.js's ABR abandon rules read them during the load and may abort; `abort()` drops the held
  response and frees the virtual link.
- If the simulated transfer exceeds hls.js's `loadPolicy` (`maxTimeToFirstByteMs`,
  `maxLoadTimeMs`), `onTimeout` is called at the limit instead. That bypasses the XHR loader's
  internal retry; hls.js's error controller handles the timeout.
- Errors only get the added latency. `onProgress` callbacks (progressive streaming) are passed
  through unshaped.
- The setting lives in React state, not in the URL, so a shared link never throttles the
  recipient silently. The Player shows a "Throttled" badge while it is on. The alignment probe and
  the CORS probe are not throttled.

## Loudness meter (Web Audio)

- `audio/audio-graph.ts` keeps one graph per `<video>` element in a module-level `WeakMap`,
  because `createMediaElementSource` can only be called once per element and the element
  outlives sessions. Graph: `source → destination` (so audio stays audible) and
  `source → AudioWorkletNode → gain(0) → destination` (the silent path keeps the worklet pulled
  by the render graph). The node uses `channelInterpretation: 'discrete'` so BS.1770 sees the
  real channels without up/down-mixing.
- The worklet (`loudness.worklet.ts`, loaded with Vite's `?worker&url` so it is bundled like a
  worker) runs `LoudnessProcessor` on the audio thread and posts one block per 100 ms.
- `LoudnessMeter` (one per session, so integrated loudness restarts per URL) feeds the blocks to
  `LoudnessAnalyzer` and records a 2 Hz chart series on the session's sampling tick.
- The meter taps the element's output, so starting it sets `muted = false` and `volume = 1`, and
  blocks are ignored (status `paused`) while the element is muted, below 100 % volume or paused.
  The graph is created on the first "Measure loudness" click; that user gesture is what lets the
  browser run the `AudioContext` and unmuted playback. Once created, the element's audio always
  goes through the context, even after the meter is stopped.
- MSE playback (what hls.js uses) is not cross-origin-tainted, so Web Audio receives real
  samples for CORS-enabled streams. Native HLS playback (Safari without MSE) would not be
  measurable, but the monitor only runs on hls.js.

## Variant alignment probe

hls.js only loads the playlist of the active level, so alignment between variants can't be
observed passively. On `MANIFEST_PARSED` of a master with more than one level,
`AlignmentProber` fetches every `hls.levels[i].uri` concurrently with `fetch(…, { cache:
'no-store' })`: once for VOD, then every 30 s while any variant is live. The requests bypass
hls.js, so they are not throttled and not shown in the network table; the panel shows how many
were made. They are aborted on `destroy()`. `compareVariants` (`alignment.ts`) then compares the
playlists (see `docs/metrics.md`). Alternate renditions (EXT-X-MEDIA) are not probed.

## Session report (`report/build-report.ts`)

`buildMarkdownReport(snapshot, ctx)` renders the whole `MonitorSnapshot` as Markdown: panel-style
summaries, full tables of every record (segments, playlist loads, parts, errors, findings,
stalls, alignment issues, per-PID continuity), and the raw time series (samples, loudness) and
per-segment details (PMT streams, PIDs, response headers) as appendices.

- It is a pure function. Everything outside the snapshot comes in through `ReportContext`:
  `performance.timeOrigin`, the generation time, the throttle profile, the requested variant and
  whether the loudness meter is on. That keeps tests deterministic and the engine free of React
  state.
- "Everything" means what the engine still holds: the 30-minute retention window and the hard
  buffer capacities. The report states the covered range. Loudness data only exists while the
  meter is on; stopping the meter discards it.
- Times are ISO 8601 UTC (`timeOrigin + t`), not the local clock format the panels use, so a
  report stays unambiguous when read elsewhere. The file name uses a UTC timestamp too.
- Table cells go through `escapeCell` (`|` escaped, line breaks collapsed), because messages and
  URLs come from the server and hls.js.
- Panels and report share their aggregations through the engine (`summarizeChecks`,
  `framesByLevel`, `continuityByPid`, `sessionUsesLlHls`) so they can't disagree.

## Error classification

The single source is the hls.js `ERROR` event. `classifyHlsError` maps it to
`cors | http4xx | http5xx | timeout | decode | parse`:

- `*_TIMEOUT` → `timeout`.
- Network errors are split by HTTP status: `>= 500` → `http5xx`, other non-zero → `http4xx`.
  Status `0` or no response → `cors`.
- Parsing failures and `fragParsingError` → `parse`. Failures of the monitor's own TS parser
  (`tsParseError`) also land here.
- Media, buffer and key-system errors, plus `<video>` element errors → `decode`.
- Stalls, nudges, gaps, buffer-full and unchanged playlists are not logged as errors. They have
  dedicated collectors, or hls.js self-heals them.

A status-0 failure looks the same to page JS whether it was a CORS rejection or an unreachable
server. To tell them apart, the session sends one `fetch(url, { method: 'HEAD', mode: 'no-cors' })`
per URL:

- If the probe resolves, the server answered and the failure was CORS
  (`corsConfirmed: true`).
- If it rejects, the server is unreachable (`corsConfirmed: false`).

Mixed content (an http stream on an https page) is detected up front from the URLs alone.

## Variants

The `?variant=` index refers to `hls.levels`. hls.js may sort and filter levels relative to the
master playlist order. A forced variant uses `hls.currentLevel = i`, which switches immediately
and turns ABR off. `auto` uses `hls.loadLevel = -1`, which returns to ABR without flushing the
buffer.

Declared values (BANDWIDTH, AVERAGE-BANDWIDTH, CODECS) come from `level.attrs`, which are the raw
attributes the server sent.

## Testing

Engine modules are unit-tested in Node (`npx vitest run src/monitor`). `session.test.ts` mocks
hls.js, the worker client and the CORS probe, and drives the session through the real monitoring
loader to check the wiring end to end.
