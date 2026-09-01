#!/usr/bin/env python3
"""Strict structural check of the Ogg Opus streams Nakama's muxer produced.

ffmpeg decodes leniently — it resyncs past a bad CRC and infers duration from
whatever it finds — so "ffmpeg reports no errors" is not evidence that the
lacing, checksums or granule arithmetic in recorder_audio.ts are right. This
recomputes all of it from the bytes independently.
"""
import struct
import sys

# Ogg's CRC32: 0x04c11db7, no reflection, init 0, no final xor. Not zlib's.
def _table():
    t = []
    for i in range(256):
        r = i << 24
        for _ in range(8):
            r = ((r << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if r & 0x80000000 else (r << 1) & 0xFFFFFFFF
        t.append(r)
    return t

CRC_TABLE = _table()


def ogg_crc(buf):
    crc = 0
    for b in buf:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ CRC_TABLE[((crc >> 24) & 0xFF) ^ b]
    return crc


CONFIG_FRAME_MICROS = [
    10000, 20000, 40000, 60000, 10000, 20000, 40000, 60000,
    10000, 20000, 40000, 60000, 10000, 20000, 10000, 20000,
    2500, 5000, 10000, 20000, 2500, 5000, 10000, 20000,
    2500, 5000, 10000, 20000, 2500, 5000, 10000, 20000,
]


def packet_samples(pkt):
    """Sample count at 48 kHz implied by an Opus packet's TOC byte."""
    toc = pkt[0]
    micros = CONFIG_FRAME_MICROS[toc >> 3]
    code = toc & 0x03
    if code == 0:
        frames = 1
    elif code in (1, 2):
        frames = 2
    else:
        frames = pkt[1] & 0x3F
    return int(micros * frames * 48 / 1000)


def verify(path):
    data = open(path, "rb").read()
    errs = []
    pages = []
    off = 0
    while off < len(data):
        if data[off:off + 4] != b"OggS":
            errs.append("page %d: no OggS capture pattern at byte %d" % (len(pages), off))
            break
        ver, flags, granule, serial, seq, crc, nsegs = struct.unpack_from("<BBqIIIB", data, off + 4)
        seg_table = data[off + 27:off + 27 + nsegs]
        if len(seg_table) != nsegs:
            errs.append("page %d: segment table truncated" % len(pages))
            break
        body_len = sum(seg_table)
        page_len = 27 + nsegs + body_len
        page = bytearray(data[off:off + page_len])
        if len(page) != page_len:
            errs.append("page %d: body truncated (want %d, have %d)" % (len(pages), page_len, len(page)))
            break

        if ver != 0:
            errs.append("page %d: version %d, must be 0" % (len(pages), ver))
        # CRC is computed with the CRC field itself zeroed.
        page[22:26] = b"\x00\x00\x00\x00"
        actual = ogg_crc(bytes(page))
        if actual != crc:
            errs.append("page %d: CRC mismatch (header 0x%08x, recomputed 0x%08x)"
                        % (len(pages), crc, actual))

        # Rebuild packets from the lacing values.
        body = data[off + 27 + nsegs:off + page_len]
        packets, incomplete = [], False
        pos = 0
        cur = bytearray()
        for lace in seg_table:
            cur.extend(body[pos:pos + lace])
            pos += lace
            if lace < 255:
                packets.append(bytes(cur))
                cur = bytearray()
        if cur:
            incomplete = True  # packet continues on the next page

        pages.append({
            "flags": flags, "granule": granule, "serial": serial, "seq": seq,
            "nsegs": nsegs, "body_len": body_len, "packets": packets,
            "incomplete": incomplete, "seg_table": seg_table,
        })
        off += page_len

    if not pages:
        return ["no pages parsed"], None

    # ── Stream-level invariants ──────────────────────────────────────────────
    if not (pages[0]["flags"] & 0x02):
        errs.append("first page must set BOS (0x02), got 0x%02x" % pages[0]["flags"])
    if not (pages[-1]["flags"] & 0x04):
        errs.append("last page must set EOS (0x04), got 0x%02x" % pages[-1]["flags"])
    serials = set(p["serial"] for p in pages)
    if len(serials) != 1:
        errs.append("mixed serial numbers: %s" % sorted(serials))
    for i, p in enumerate(pages):
        if p["seq"] != i:
            errs.append("page %d carries sequence number %d" % (i, p["seq"]))
        if p["nsegs"] > 255:
            errs.append("page %d: %d segments, max 255" % (i, p["nsegs"]))

    # ── Header packets ───────────────────────────────────────────────────────
    head = pages[0]["packets"][0] if pages[0]["packets"] else b""
    if head[:8] != b"OpusHead":
        errs.append("page 0 packet 0 is not OpusHead")
        return errs, None
    ver, chans, pre_skip, rate, gain, mapping = struct.unpack_from("<BBHIhB", head, 8)
    if ver != 1:
        errs.append("OpusHead version %d, must be 1" % ver)
    if pages[0]["granule"] != 0:
        errs.append("OpusHead page granule must be 0, got %d" % pages[0]["granule"])
    tags_page = pages[1] if len(pages) > 1 else None
    if not tags_page or not tags_page["packets"] or tags_page["packets"][0][:8] != b"OpusTags":
        errs.append("page 1 must be OpusTags")
    elif tags_page["granule"] != 0:
        errs.append("OpusTags page granule must be 0, got %d" % tags_page["granule"])

    # ── Granule arithmetic ───────────────────────────────────────────────────
    # Every audio page's granule must equal pre_skip plus the samples of every
    # packet completed at or before it. That is the one number a player uses to
    # seek and to report duration, and it is pure integer code in the muxer.
    audio_pages = pages[2:]
    running = pre_skip
    total_packets = 0
    prev = None
    for i, p in enumerate(audio_pages):
        for pkt in p["packets"]:
            running += packet_samples(pkt)
            total_packets += 1
        if p["incomplete"]:
            errs.append("audio page %d ends mid-packet; the muxer emits whole packets" % i)
        if p["granule"] != running:
            errs.append("audio page %d: granule %d, expected %d (delta %+d)"
                        % (i, p["granule"], running, p["granule"] - running))
        if prev is not None and p["granule"] < prev:
            errs.append("audio page %d: granule went backwards (%d < %d)" % (i, p["granule"], prev))
        prev = p["granule"]

    stats = {
        "pages": len(pages), "audio_pages": len(audio_pages), "packets": total_packets,
        "pre_skip": pre_skip, "channels": chans, "rate": rate, "gain": gain,
        "mapping": mapping, "final_granule": pages[-1]["granule"],
        "duration_s": (pages[-1]["granule"] - pre_skip) / 48000.0,
        "max_segs": max(p["nsegs"] for p in pages),
    }
    return errs, stats


if __name__ == "__main__":
    bad = 0
    for path in sys.argv[1:]:
        errs, st = verify(path)
        name = path.split("/")[-1][24:]
        if errs:
            bad += 1
            print("FAIL %s" % name)
            for e in errs[:10]:
                print("       %s" % e)
        else:
            print("OK   %-30s pages=%d audio=%d packets=%d pre_skip=%d ch=%d "
                  "rate=%d gain=%d map=%d granule=%d dur=%.4fs max_segs=%d"
                  % (name, st["pages"], st["audio_pages"], st["packets"], st["pre_skip"],
                     st["channels"], st["rate"], st["gain"], st["mapping"],
                     st["final_granule"], st["duration_s"], st["max_segs"]))
    print("\n%d file(s), %d failed" % (len(sys.argv) - 1, bad))
    sys.exit(1 if bad else 0)
