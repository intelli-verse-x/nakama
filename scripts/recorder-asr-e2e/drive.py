#!/usr/bin/env python3
"""End-to-end driver for the Curio recorder ASR RPCs against a live Nakama.

Replays what the Flutter client does — authenticate, recorder_asr_open, a stream
of recorder_asr_push with base64 audio chunks, recorder_asr_close — using real
speech, and checks that text comes back.

Chunk boundaries are deliberately NOT codec-frame aligned, because the client
packs BLE payloads and a BLE notification is not an Opus packet boundary.
"""
import base64
import json
import sys
import time
import urllib.error
import urllib.request
import uuid

NAKAMA = "http://127.0.0.1:7350"
SERVER_KEY = "defaultkey"


def http(method, path, body=None, headers=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(NAKAMA + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def authenticate():
    basic = base64.b64encode((SERVER_KEY + ":").encode()).decode()
    status, body = http(
        "POST", "/v2/account/authenticate/device?create=true&username=e2e_%s" % uuid.uuid4().hex[:8],
        {"id": "e2e-device-" + uuid.uuid4().hex},
        {"Authorization": "Basic " + basic},
    )
    if status != 200:
        raise SystemExit("auth failed: %s %s" % (status, body))
    return body["token"]


def rpc(token, name, payload, timeout=60):
    # Nakama's HTTP RPC takes the payload as a JSON *string* in the body and
    # returns it the same way.
    status, body = http(
        "POST", "/v2/rpc/" + name,
        json.dumps(payload),
        {"Authorization": "Bearer " + token},
        timeout=timeout,
    )
    if status != 200:
        raise SystemExit("%s transport failure: %s %s" % (name, status, body))
    return json.loads(body.get("payload") or "{}")


def run(token, label, audio, codec, chunk_bytes, expect_words, expect_phrases):
    print("\n=== %s ===" % label)
    print("audio: %d bytes, codec=%s, chunk=%d bytes (chunk %% 40 = %d)"
          % (len(audio), codec, chunk_bytes, chunk_bytes % 40))

    client_session_id = "e2e_" + uuid.uuid4().hex[:12]
    opened = rpc(token, "recorder_asr_open", {
        "contract_version": "2026-08-27",
        "locale": "en_US",
        "client_session_id": client_session_id,
        "audio": {"codec": codec, "sample_rate_hz": 16000, "channels": 1, "frame_ms": 20},
        "age_assertion": {
            "bracket": "at_or_above_threshold", "min_age": 13,
            "declared_at": "2026-08-28T00:00:00Z",
        },
    })
    if "error" in opened:
        print("OPEN REFUSED: %s" % opened["error"])
        return False
    session_id = opened["session_id"]
    print("open -> %s resume_from_seq=%s" % (session_id, opened.get("resume_from_seq")))

    segments = []
    seq = 0
    started = time.time()
    push_times = []
    for off in range(0, len(audio), chunk_bytes):
        chunk = audio[off:off + chunk_bytes]
        is_last = off + chunk_bytes >= len(audio)
        t0 = time.time()
        resp = rpc(token, "recorder_asr_push", {
            "contract_version": "2026-08-27",
            "session_id": session_id,
            "seq": seq,
            "is_last": is_last,
            "audio_b64": base64.b64encode(chunk).decode(),
        })
        dt = time.time() - t0
        push_times.append(dt)
        if "error" in resp:
            print("PUSH %d REFUSED: %s" % (seq, resp["error"]))
            return False
        got = resp.get("segments") or []
        if got:
            print("  push seq=%-3d %5.0fms -> %d segment(s)" % (seq, dt * 1000, len(got)))
            for s in got:
                mark = "FINAL " if s.get("is_final") else "partial"
                print("      [%s %6d-%6d ms] %s" % (mark, s["begin_ms"], s["end_ms"], s["text"]))
            segments.extend(got)
        seq += 1

    closed = rpc(token, "recorder_asr_close", {
        "contract_version": "2026-08-27", "session_id": session_id,
    })
    if "error" in closed:
        print("CLOSE REFUSED: %s" % closed["error"])
        return False
    for s in closed.get("segments") or []:
        mark = "FINAL " if s.get("is_final") else "partial"
        print("  close [%s %6d-%6d ms] %s" % (mark, s["begin_ms"], s["end_ms"], s["text"]))
    segments.extend(closed.get("segments") or [])

    elapsed = time.time() - started
    finals = [s for s in segments if s.get("is_final")]
    transcript = " ".join(s["text"] for s in finals)
    print("\n%d segment(s) (%d final), %d pushes in %.1fs, slowest push %.0fms"
          % (len(segments), len(finals), seq, elapsed, max(push_times) * 1000))
    print("TRANSCRIPT: %s" % transcript)

    ok = True
    # 1. Text actually came back.
    if not transcript.strip():
        print("FAIL: no transcript")
        ok = False
    # 2. The content is right, not just non-empty. Every ordinal from the script
    #    must appear, which only holds if windowing covered the whole recording
    #    and the seams did not eat a sentence.
    low = transcript.lower()
    # Ordinal markers are matched with a leading boundary so "4." does not also
    # match the "4." inside "base 64.".
    def count_marker(marker):
        import re
        return len(re.findall(r"(?<![0-9])" + re.escape(marker), low))
    missing = [w for w in expect_words if count_marker(w.lower()) == 0]
    if missing:
        print("FAIL: missing expected words: %s" % missing)
        ok = False
    else:
        print("PASS: all %d expected markers present" % len(expect_words))
    # 3. Overlap de-duplication: no ordinal may appear twice in committed text.
    missing_p = [p for p in expect_phrases if p.lower() not in low]
    if missing_p:
        print("FAIL: missing expected phrases: %s" % missing_p)
        ok = False
    else:
        print("PASS: all %d sentence phrases present" % len(expect_phrases))
    dupes = [w for w in expect_words if count_marker(w.lower()) > 1]
    dupes += [p for p in expect_phrases if low.count(p.lower()) > 1]
    if dupes:
        print("FAIL: duplicated across a window seam: %s" % dupes)
        ok = False
    else:
        print("PASS: nothing duplicated across window seams")
    # 4. Timing offsets: finals must be ordered and land inside the recording.
    bad = []
    prev = -1
    for s in finals:
        if s["begin_ms"] < prev:
            bad.append(("out of order", s))
        if s["end_ms"] < s["begin_ms"]:
            bad.append(("negative duration", s))
        prev = s["begin_ms"]
    span = finals[-1]["end_ms"] if finals else 0
    if bad:
        print("FAIL: segment timing: %s" % bad[:3])
        ok = False
    else:
        print("PASS: %d final segments monotonically ordered, span 0-%d ms" % (len(finals), span))
    return ok


def main():
    token = authenticate()
    print("authenticated")
    # Whisper writes the spoken ordinals as digits ("1." not "One"), so the
    # markers are matched in the form the engine actually emits.
    markers = ["1.", "2.", "3.", "4.", "5.", "6."]
    # Distinctive phrases, one per sentence: these must appear exactly once in
    # committed text. Duplicates here mean a window seam re-emitted text.
    phrases = [
        "curio recorder", "captured on the device", "wrapped it in a container",
        "each push transcribes", "cut in half", "become text",
    ]

    results = {}
    pcm = open("/tmp/e2e/speech.pcm", "rb").read()
    # ~68.8 kB is the client's biggest real pcm16 chunk: a 4300-byte Opus window
    # expanded 16x by local decode. 68800 % 40 != 0, so this is not frame-aligned.
    results["pcm16 -> WAV"] = run(token, "pcm16 (WAV muxer)", pcm, "pcm16", 68800, markers, phrases)

    bare = open("/tmp/e2e/speech.bareopus", "rb").read()
    # 4300 bytes is PenAudioChunker's window. 4300 % 40 = 20, i.e. every chunk
    # boundary lands mid-packet, which is the real condition.
    results["opus -> Ogg"] = run(token, "bare opus (Ogg muxer)", bare, "opus", 4300, markers, phrases)

    print("\n================ SUMMARY ================")
    for k, v in results.items():
        print("%-16s %s" % (k, "PASS" if v else "FAIL"))
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
