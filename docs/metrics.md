# Metric definitions

All durations come from `performance.now()` timestamps. hls.js `LoaderStats` use the same clock.
Wall-clock time appears only for display (`performance.timeOrigin + t`) and for PDT latency.

When network simulation is on, every request timing below (TTFB, total, throughput, ratio,
playlist intervals, part hold) is the **simulated** one: the loader rewrites `LoaderStats`
before the monitor records them. See `docs/architecture.md`.

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

## Measured segment duration and codec strings (MPEG-TS worker)

- **PTS range** is the min/max PES PTS of the reference stream (video if present, else the first
  stream with PTS). Min/max, not first/last, because video PES arrive in decode order. PTS are
  unwrapped against the first PTS of the segment, so a 33-bit rollover inside a segment does not
  break the span.
- **Measured duration** = `(max − min) · n / (n − 1)`, with `n` PES packets: the PTS span plus
  one average PES duration. For video (one access unit per PES) that is exact for constant frame
  rate. For audio it assumes PES of equal duration, which is true for common packagers except
  for a shorter last PES.
- `extinf-mismatch` warns when `|measured − EXTINF| > EXTINF_TOLERANCE_S` (0.1 s, in
  `checks.ts`): about 2–3 video frames, well above the rounding of a 3-decimal EXTINF.
  Playlists with integer EXTINF (EXT-X-VERSION < 3) will usually warn, which is intended: the
  spec asks for accurate durations.
- **Codec strings** come from the start of the first PES of each stream (up to 4 KB, across
  packets): `avc1.PPCCLL` from the first SPS; `mp4a.40.<aot>`, sample rate and channel
  configuration from the first ADTS header (ADTS carries the base object type, so HE-AAC with
  implicit SBR reads as `mp4a.40.2` while CODECS may say `mp4a.40.5`); `ac-3` (with sample
  rate), `ec-3`, `mp4a.40.34` for the rest. HEVC strings are not derived: Apple requires fMP4
  for HEVC and fMP4 is not parsed.

## TS continuity (`src/monitor/continuity.ts`)

The TS worker counts, per PID, packets and continuity-counter jumps: a CC that is neither the
previous value (a legal duplicate packet) nor previous + 1 (mod 16), on packets with payload,
unless the adaptation field sets `discontinuity_indicator`. Only jumps *inside* a segment are
counted. HLS does not require CC to continue across segments, and many packagers restart it, so
cross-segment checks would be noise. Null packets (PID 0x1FFF) are ignored.

The panel sums packets and errors per (track, level, PID) over the analyzed segments in the
retention window. The `ts-continuity` spec check counts affected segments per (level, PID).

## Variant alignment (`src/monitor/alignment.ts`)

The reference is the lowest level; an issue lists the levels that differ from it. Segment-level
comparisons only use SNs listed by every variant, so live playlists fetched a few ms apart still
compare. Tolerance `ALIGNMENT_TOLERANCE_S` = 0.1 s (about 2–3 frames).

| Issue | Rule |
| --- | --- |
| `extinf` | Same SN, EXTINF differs by more than 0.1 s. |
| `discontinuity` | Same SN, different discontinuity sequence (EXT-X-DISCONTINUITY-SEQUENCE + tags so far): discontinuities are not at the same place. |
| `pdt` | Same SN, PROGRAM-DATE-TIME differs by more than 0.1 s. |
| `pts` | Same SN downloaded on several levels by hls.js (ABR switches), start PTS (TS only) differs by more than 0.1 s. |
| `window` | Live: no SN in common. VOD: different SN range, or total duration differing by more than 1 s. |

Each kind is one `variant-alignment` finding, counted per SN. A variant that can't be fetched
is an info finding.

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

## Samples (every 500 ms, `MonitorSession.sample`)

| Metric | Definition |
| --- | --- |
| Buffer ahead | End of the `video.buffered` range that contains `currentTime`, minus `currentTime` (0.1 s tolerance at the range start). 0 when the playhead is outside any buffered range. |
| Behind live edge | `hls.latency`: the live edge (end of the live playlist) minus the playhead, in seconds. Live only, and only after the first `playing` event, because before that `currentTime` is 0 and the value is meaningless. |
| Latency vs PDT | `(Date.now() − hls.playingDate) / 1000`. `playingDate` is the PROGRAM-DATE-TIME mapped to the playhead. This is glass-to-glass-ish latency from the packager's clock, so it is only correct if the client's clock agrees with the packager's. Absent when the playlist has no PDT. |

## Dropped frames (`src/monitor/frames.ts`)

Each sample stores the cumulative `droppedVideoFrames` / `totalVideoFrames` from
`video.getVideoPlaybackQuality()` and `hls.currentLevel`. The panel works on deltas between
consecutive samples:

- **Dropped/s** = Δdropped / Δt.
- **Per level**: each delta is attributed to the level playing at the later sample, so frames
  around a switch may land on the neighbouring level (one 500 ms sample of slack).
- A counter that goes backwards means the browser reset them (the media load algorithm runs on
  every `attachMedia`). That sample becomes a new baseline; no negative delta is produced.
- Browsers may skip rendering in a hidden tab or when the video is off screen, and some count
  those frames as dropped. Read the numbers with the tab visible.

## Loudness (`src/monitor/audio/loudness.ts`)

ITU-R BS.1770-4 / EBU R128, split in two halves:

- `LoudnessProcessor` (sample level, runs in the AudioWorklet): K-weighting (high-shelf +
  RLB high-pass biquads, coefficients derived for any sample rate from the analog prototypes
  as in libebur128; they match the BS.1770 table at 48 kHz), then per 100 ms sub-block
  `energy = Σ Gᵢ · mean(yᵢ²)` with channel weights 1 (L, R, C), 1.41 (surrounds), 0 (LFE) for
  5.1 in Web Audio order; any other layout weighs every channel 1.
- **True peak**: 4× oversampling with the 48-tap interpolation filter of BS.1770-4 Annex 2, on
  the unfiltered signal; the max of the sample and the 3 interpolated values. Reported in dBTP.
- `LoudnessAnalyzer` (main thread):
  - **Momentary** = loudness of the mean energy of the last 4 sub-blocks (400 ms).
  - **Short-term** = last 30 sub-blocks (3 s).
  - **Integrated**: every 100 ms completes a 400 ms gating block (75 % overlap). Blocks below
    −70 LUFS are dropped (absolute gate); the relative threshold is the loudness of the
    remaining blocks − 10 LU; integrated = loudness of the mean energy of blocks above both.
    Blocks go into a 0.1 LU histogram holding counts and exact energy sums, so memory is
    constant for any duration and the only approximation is the relative threshold (≤ 0.1 LU).
  - `L = −0.691 + 10·log10(energy)`.
- Verified against EBU Tech 3341-style signals (1 kHz stereo sine at −23 dBFS reads −23 LUFS
  ±0.1 at 44.1 and 48 kHz; relative gating of quiet passages).

## Stalls

A stall starts on the `<video>` `waiting` event and ends on the next `playing` (or `seeking`).
Durations are measured with `performance.now()`. The following are not stalls:

- `waiting` before the first `playing` (startup).
- `waiting` while `video.seeking` is true (user seeks).

A stall still in progress has no `durationMs`. The chart extends it to the latest sample.

## Charts

Series colors are `--chart-1` (blue) and `--chart-2` (orange). Both were validated for CVD
separation and contrast on the light and dark surfaces. Stall bands use `--status-error`, and the
stall list next to the chart repeats each one in text, so color is never the only signal.
