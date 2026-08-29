# recorder-asr end-to-end proof

The harness that first turned a recording into text through
`recorder_asr_open` / `_push` / `_close`, and the independent checkers for the
container muxers.

These exist because the windowing, overlap de-duplication, segment timing and
the Ogg/WAV muxers are pure integer code that had never been executed against a
real speech engine. Reading it and finding it plausible is not evidence.

## What each file does

| File             | Purpose |
|------------------|---------|
| `gen_audio.sh`   | Synthesises ~30 s of numbered speech (`say` → ffmpeg) as 16 kHz mono PCM16, and as bare Opus packets. |
| `ogg_to_bare.py` | Demuxes an Ogg Opus file into the bare-packet stream the Curio device sends. |
| `drive.py`       | Drives the real RPCs over HTTP: authenticate, `open`, chunked `push`, `close`; then checks the transcript for missing text, seam duplication and timing order. |
| `wav_verify.py`  | Recomputes every WAV header field from the payload length. |
| `ogg_verify.py`  | Recomputes every Ogg page CRC, the lacing, and the granule for every page. |
| `script.txt`     | The spoken script — six numbered sentences, so a missing or duplicated one is visible by eye. |
| `avail_probe.py` | Calls `recorder_asr_open` and reports whether it accepted or refused, and why. Used to prove the availability signal fails closed. |
| `gc_loop.py`     | Drives `recorder_asr_gc` the way the CronJob does, looping while `budget_exhausted` is true, and times each call. |

The two verifiers are deliberately independent of ffmpeg. ffmpeg resyncs past a
bad CRC and infers duration from whatever it finds, so "ffmpeg reports no
errors" does not establish that the muxer's arithmetic is right.

## Running it

```bash
# 1. A real engine. The stub proves the transport only, not the muxing.
docker run --rm -p 8799:8000 fedirz/faster-whisper-server:latest-cpu
#    First run pulls ~2 GB and cold-loads the model; wait for /health to answer
#    before starting, or the first window times out.

# 2. Nakama + the shim, pointed at that engine. Dumping the forwarded
#    containers is what makes step 4 possible.
cd <repo root>
RECORDER_ASR_BASE_URL=http://host.docker.internal:8799 \
RECORDER_ASR_SHIM_DUMP_DIR=/tmp/asr-dump \
  docker compose up -d

# 3. Generate audio and drive both codecs.
cd scripts/recorder-asr-e2e
./gen_audio.sh
python3 drive.py

# 4. Verify the containers Nakama actually produced.
docker compose cp recorder_asr_shim:/tmp/asr-dump /tmp/asr-verify/
python3 wav_verify.py /tmp/asr-verify/asr-dump/*.wav
python3 ogg_verify.py /tmp/asr-verify/asr-dump/*.ogg
```

`RECORDER_ASR_SHIM_DUMP_DIR` writes every forwarded recording to disk. It is for
this harness only — never set it anywhere real.

## Result on 2026-08-28

Engine: `fedirz/faster-whisper-server:latest-cpu`, `Systran/faster-whisper-small.en`,
CPU int8. Not a stub.

Both codec paths PASS: all six sentences present, none duplicated across a
window seam, six final segments monotonically ordered spanning 0–27.4 s, 13
pushes in ~7 s with the slowest push at 1.9 s.

Muxer checks, 10 containers (5 WAV, 5 Ogg Opus):

- WAV — every RIFF/fmt/data size, byte rate and block align recomputed and
  matched; payload a whole number of frames; 16 kHz/1ch/16-bit throughout.
- Ogg Opus — every page CRC recomputed with Ogg's non-reflected CRC32 and
  matched; BOS/EOS set; page sequence numbers contiguous; single serial; no page
  ending mid-packet; lacing ≤ 50 segments per page. Granule equals `pre_skip`
  plus the cumulative samples of every packet completed at or before each page,
  exactly, on every page — e.g. 496 packets × 960 samples + 312 = 476,472,
  matching the header. Duration after subtracting pre-skip is exactly
  packets × 20 ms.

### Availability fails closed

`avail_probe.py` against each broken topology. All four measured 2026-08-28:

| Topology | `open` answers | Latency |
|---|---|---|
| shim up, engine up | accepts, returns a `session_id` | 0.1 s |
| engine stopped, shim up | `ENDPOINT_UNAVAILABLE`, reason names the engine probe | 0.2 s |
| shim stopped | `ENDPOINT_UNAVAILABLE`, reason names `/healthz` not answering | 0.2 s |
| shim reachable but hung (accepts TCP, never replies) | `ENDPOINT_UNAVAILABLE`, `context deadline exceeded` | 4.1 s |

The hung case is the one that matters most, because it is the only one where
`open` could plausibly have hung instead of answering — and an `open` that never
answers costs the client its on-device fallback just as surely as a false
"available" does.

### Bugs this found

Five, all in code that unit tests passed and that read correctly:

1. **Overlap was re-fed unconditionally**, so the engine re-transcribed the tail
   of an already-committed sentence and returned a segment straddling the
   watermark. Text duplicated at every seam and `begin_ms` moved backwards.
2. **The `force` flush at `close` dropped the final utterance**, because
   Whisper's timestamps can extend past the audio and the boundary check then
   excluded it.
3. **The global sweep could never scan anything.** It passed `""` as the
   all-owners `userId`, and `server/runtime_javascript_nakama.go:4717` only skips
   the UUID parse for `undefined` and `null` — an empty string reaches
   `uuid.FromString`, fails, and panics, despite the panic message naming
   "empty" as acceptable. The listing threw on its first iteration every time and
   the sweep reported a clean `scanned=0`. The mock now rejects `""` too.
4. **`acked_seq` had no ceiling.** It is client-supplied, and both
   `readWindowBytes` and `deleteChunks` derive a dense key range from it. A
   session reached `acked_seq = 91736` and the resulting 91,737-key delete took
   42 s in one transaction — past Nakama's socket write timeout, so the sweep's
   answer was lost for work that had completed. With a larger `seq` it is
   unbounded memory from one integer. `rpcPush` now caps the gap, both walks are
   bounded, and deletes are batched.
5. **The health probe budget was tight.** The refusal path probes twice
   (`isAvailable`, then `unavailableReason` for the detail), so a hung shim cost
   6.1 s at 3,000 ms each against a 10 s write timeout. Now 2,000 ms, worst case
   4.1 s measured.

A sixth defect is the engine's, and is defended against rather than fixed: on
one Ogg window it looped, emitting the same 95-character sentence three times
with 240/80/80 ms durations (~1,190 chars/s).
`RecorderAsrProvider.isRepetitionArtifact` drops segments above 60 chars/s, and
the drop is logged as `dropped_repetitions=N`. Confirmed firing live:
`provider ok bytes=20719 segments=2 dropped_repetitions=3`.
