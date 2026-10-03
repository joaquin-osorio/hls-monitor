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
