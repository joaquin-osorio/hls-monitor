# LL-HLS

hls.js 1.7 runs with `lowLatencyMode: true` by default, so on an LL-HLS stream it uses blocking
playlist reloads and loads **parts** near the live edge instead of whole segments.

## What hls.js sends through the loader

- **Parts** are `media-fragment` requests whose `context.part` is set (`index`, `duration`,
  `independent`); `context.frag` is the parent segment. The loader records `part`,
  `partDuration` and `independent` on the `RequestRecord`. `duration` stays the parent
  segment's duration (which hls.js may still be growing for the segment in progress).
- **Blocking playlist reloads** add `_HLS_msn` / `_HLS_part` (and `_HLS_skip` for delta
  updates) to the playlist URL. The loader parses them into `RequestRecord.blocking`. The
  response is held by the server until that MSN/part exists, so playlist TTFB is hold time,
  not network latency.

## How parts are recorded

- `SegmentLog` folds part attempts into the parent segment record: `partsLoaded`,
  `partErrors`, summed `bytes`, status `error` if the latest part failed. `attempts` stays 0,
  and TTFB/total/throughput/ratio stay undefined, because blocking part requests make them
  meaningless. If hls.js later loads the full segment (e.g. after seeking back), that attempt
  takes precedence.
- Parts are never sent to the TS worker: they rarely start with PAT/PMT.
- Measured bitrate (`Σ bytes / Σ EXTINF`) still works for part-delivered segments.

## Delta updates (EXT-X-SKIP)

A delta playlist omits `SKIPPED-SEGMENTS` segments right after MEDIA-SEQUENCE. The parser
numbers the first listed segment `mediaSequence + skippedSegments`, and `PlaylistHealthTracker`
counts skipped segments in `segmentCount` and `lastSn`. Without that, every delta update would
look like the playlist lost segments and produce false `missedSns`.

## Parsed tags

`EXT-X-PART-INF` (`partTarget`), `EXT-X-SERVER-CONTROL` (`serverControl`), `EXT-X-PART`
(attached to the following segment, or `pendingParts` for the segment still being produced),
`EXT-X-PRELOAD-HINT` (`preloadHints`), `EXT-X-RENDITION-REPORT` (`renditionReports`),
`EXT-X-SKIP` (`skippedSegments`).

## Part log and panel

`PartLog` (`src/monitor/parts.ts`) keeps one record per `(track, level, SN, part)` with the
latest attempt's hold time (TTFB), total, size and status. `LlHlsPanel` only renders once a
playlist has LL-HLS features or a part was requested. Its numbers come from the `ll` summary
that `summarizeLl` attaches to each `PlaylistRefresh`:

- Server control and part target of the latest main playlist.
- **Blocking reloads**: playlist loads with `_HLS_msn`; hold = TTFB. **Satisfied** means the
  response contains segment `msn` complete, or (with `_HLS_part`) part `part` of segment `msn`
  in the pending parts, or anything later (RFC 8216bis §6.2.5.2).
- **Preload hints** (`LlHlsTracker`): a `TYPE=PART` hint is fulfilled when its URI appears as an
  EXT-X-PART in a later load of the same playlist. It is unfulfilled when the segment it was
  hinted for (the one in progress at hint time) is listed with parts but without that URI. If
  that segment's parts already scrolled out of the playlist, no verdict is given.

A refresh that only adds parts to the segment in progress counts as `changed` in playlist
health; otherwise every part-level blocking reload would look stale.

## Checks

| Check | Rule |
| --- | --- |
| `ll-part-target` | EXT-X-PART without EXT-X-PART-INF; a part longer than PART-TARGET (+1 ms float slack). |
| `ll-server-control` | CAN-BLOCK-RELOAD=YES missing while parts are published (warn); PART-HOLD-BACK missing, or below 2 × PART-TARGET; HOLD-BACK below 3 × TARGETDURATION (also checked on regular live playlists). |
| `ll-blocking-reload` | A blocking reload returned a playlist without the requested MSN/part. |
| `ll-preload-hint` | A hinted part was never published (warn). |

Finding keys use the playlist URL with `_HLS_*` parameters stripped (`stripDeliveryDirectives`):
blocking reloads change the query on every refresh, which would otherwise create a new finding
per request. The Spec checks panel shows LL checks as "n/a" for streams without parts.

## Known limitation

hls.js sometimes requests the whole segment that is still being produced (e.g. after a stall,
when it falls behind the part window). Packagers such as Mux hold that response until the
segment is complete. Its TTFB/ratio then include hold time and the throughput (measured after
the first byte) is inflated. There is no reliable signal in the request to tell it apart.
