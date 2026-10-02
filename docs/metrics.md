# Metric definitions

All durations come from `performance.now()` timestamps. hls.js `LoaderStats` use the same clock.
Wall-clock time appears only for display (`performance.timeOrigin + t`) and for PDT latency.

## Per-segment network (`src/monitor/segments.ts`)

Each segment record folds every attempt hls.js made for one `(track, level, SN)`. Metrics come
from the latest attempt. Aborts are ignored; hls.js aborts in-flight loads on level switches.

| Metric | Definition |
| --- | --- |
| TTFB | `loading.first − loading.start`. `first` is set when response headers arrive (XHR `readyState ≥ 2`), so it includes DNS, TLS, request and server think time. |
| Total | `loading.end − loading.start`. |
| Throughput | `bytes × 8 / (end − first)`: the transfer rate after the first byte. If the body arrives in the same millisecond as the headers (small or cached responses), total time is used instead to avoid absurd numbers. |
| Ratio | `total / EXTINF`. At 1 or above, the download takes longer than playing the segment, so the client cannot keep up. |
| Attempts | Network attempts including retries; aborts are not counted. |

## Segment status (timeline)

| Status | Rule |
| --- | --- |
| `ok` | Latest attempt succeeded and `ratio < SLOW_RATIO` (0.5). |
| `slow` | Latest attempt succeeded and `ratio ≥ 0.5`. |
| `error` | Latest attempt failed (HTTP error, CORS/network, timeout). A later successful retry turns it back into `ok`/`slow`, with `attempts > 1`. |
| `gap` | Either `EXT-X-GAP` on the segment (`gapReason: 'tag'`), or the SN left the live window between two refreshes of its playlist before the client could see it (`gapReason: 'missed'`; its duration is assumed to be TARGETDURATION). |

Gaps are added only if the segment has no record yet, and they never overwrite a loaded segment.

## Variant bitrate

- **Declared**: `BANDWIDTH` (peak) and `AVERAGE-BANDWIDTH` from the master playlist, as sent.
- **Measured**: `Σ bytes × 8 / Σ EXTINF` over successfully loaded main-track segments of that
  level. This is the media bitrate, so it is comparable to the declared values. It is not network
  throughput.
- The UI percentage compares measured with AVERAGE-BANDWIDTH when it is present, otherwise with
  BANDWIDTH. A measured average above BANDWIDTH is highlighted, because the average should never
  exceed the declared peak. Early in a session this can be noise from only a few segments.

## Detected codecs (MPEG-TS worker)

Only codec families are compared (`avc`, `hevc`, `aac`, `mp3`, `ac3`, `eac3`), because TS stream
types do not carry profile or level. With demuxed audio (`EXT-X-MEDIA`), video segments only
contain video, so the detected set can be a subset of CODECS; only families missing *from*
CODECS are flagged. fMP4 and AES-128 encrypted segments are not analyzed.

## Playlist health (`src/monitor/playlist/health.ts`)

Each media playlist load produces a `PlaylistRefresh`, tracked per role (`main:<level>`, ...):

| Field | Meaning |
| --- | --- |
| `intervalMs` | Time since the previous load of the same playlist. For live streams, hls.js aims for about one target duration. Much longer intervals risk `missedSns`. |
| `mediaSequenceAdvance` | Change in `EXT-X-MEDIA-SEQUENCE`. Negative means the sequence went backwards (packager restart). |
| `newSegments` | Segments appended since the previous load. |
| `changed` | False when the playlist came back with the same sequence and last SN (stale playlist). |
| `missedSns` | SNs between the previous last SN and the new first SN. They were published and removed without the client ever seeing them. |
| `endListAppeared` | ENDLIST is present now but was absent before (a live stream ended). |
