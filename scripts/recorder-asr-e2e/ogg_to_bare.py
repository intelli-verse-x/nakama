#!/usr/bin/env python3
"""Ogg Opus -> concatenated bare Opus packets (the pen's wire format).

This is an independent Ogg *demuxer*: it parses page headers and the segment
table itself. That matters for the test, because the server's job is the exact
inverse (bare packets -> Ogg) and using ffmpeg for both directions would let a
shared misunderstanding cancel out.

Drops the two header packets (OpusHead, OpusTags) — the pen sends neither.
"""
import struct
import sys


def pages(blob):
    off = 0
    while off < len(blob):
        if blob[off:off + 4] != b"OggS":
            raise SystemExit("not an Ogg page at offset %d" % off)
        version = blob[off + 4]
        if version != 0:
            raise SystemExit("unexpected Ogg version %d" % version)
        header_type = blob[off + 5]
        granule = struct.unpack_from("<q", blob, off + 6)[0]
        nsegs = blob[off + 26]
        table = blob[off + 27:off + 27 + nsegs]
        body_off = off + 27 + nsegs
        body_len = sum(table)
        body = blob[body_off:body_off + body_len]
        yield header_type, granule, table, body
        off = body_off + body_len


def main():
    blob = open(sys.argv[1], "rb").read()
    packets = []
    pending = b""
    last_granule = 0
    npages = 0
    for header_type, granule, table, body in pages(blob):
        npages += 1
        last_granule = granule
        pos = 0
        for lace in table:
            pending += body[pos:pos + lace]
            pos += lace
            # A lacing value < 255 terminates the packet.
            if lace < 255:
                packets.append(pending)
                pending = b""
    if pending:
        packets.append(pending)

    if not packets[0].startswith(b"OpusHead"):
        raise SystemExit("first packet is not OpusHead")
    if not packets[1].startswith(b"OpusTags"):
        raise SystemExit("second packet is not OpusTags")
    audio = packets[2:]

    sizes = sorted(set(len(p) for p in audio))
    print("pages=%d audio_packets=%d packet_sizes=%s granule_end=%d (%.3fs @48k)"
          % (npages, len(audio), sizes, last_granule, last_granule / 48000.0))
    if len(sizes) != 1:
        # The server's packet-size probe assumes CBR. If ffmpeg gave us VBR the
        # fixture is wrong and the test would be measuring the wrong thing.
        raise SystemExit("bare-Opus fixture is not fixed-size: %s" % sizes)

    with open(sys.argv[2], "wb") as fh:
        for p in audio:
            fh.write(p)
    print("wrote %s: %d bytes, %d x %d-byte packets"
          % (sys.argv[2], len(audio) * sizes[0], len(audio), sizes[0]))


if __name__ == "__main__":
    main()
