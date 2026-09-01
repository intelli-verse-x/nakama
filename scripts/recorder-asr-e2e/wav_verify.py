#!/usr/bin/env python3
"""Strict check of the WAV headers Nakama's muxer wrote.

Every field is recomputed from the payload length rather than read back, since
a header that merely parses can still declare the wrong byte rate and make a
decoder resample silently.
"""
import struct, sys

def verify(path, want_rate=16000, want_ch=1):
    d = open(path, "rb").read()
    e = []
    if d[0:4] != b"RIFF": e.append("no RIFF magic")
    if d[8:12] != b"WAVE": e.append("no WAVE type")
    riff_size, = struct.unpack_from("<I", d, 4)
    if riff_size != len(d) - 8:
        e.append("RIFF size %d, expected %d" % (riff_size, len(d) - 8))
    if d[12:16] != b"fmt ": e.append("no fmt chunk at byte 12")
    fmt_size, = struct.unpack_from("<I", d, 16)
    if fmt_size != 16: e.append("fmt size %d, expected 16 for PCM" % fmt_size)
    tag, ch, rate, byte_rate, align, bits = struct.unpack_from("<HHIIHH", d, 20)
    if tag != 1: e.append("format tag %d, expected 1 (PCM)" % tag)
    if ch != want_ch: e.append("channels %d, expected %d" % (ch, want_ch))
    if rate != want_rate: e.append("sample rate %d, expected %d" % (rate, want_rate))
    if bits != 16: e.append("bits %d, expected 16" % bits)
    if align != ch * bits // 8: e.append("block align %d, expected %d" % (align, ch*bits//8))
    if byte_rate != rate * align:
        e.append("byte rate %d, expected %d" % (byte_rate, rate * align))
    if d[36:40] != b"data": e.append("no data chunk at byte 36")
    data_size, = struct.unpack_from("<I", d, 40)
    payload = len(d) - 44
    if data_size != payload:
        e.append("data size %d, but %d bytes follow the header" % (data_size, payload))
    if payload % align: e.append("payload %d is not a whole number of frames" % payload)
    return e, {"bytes": len(d), "payload": payload,
               "duration_s": payload / float(byte_rate) if byte_rate else 0,
               "rate": rate, "ch": ch, "bits": bits}

bad = 0
for p in sys.argv[1:]:
    e, st = verify(p)
    n = p.split("/")[-1][24:]
    if e:
        bad += 1; print("FAIL %s" % n)
        for x in e: print("       %s" % x)
    else:
        print("OK   %-26s %7d bytes payload=%7d %dHz/%dch/%dbit dur=%.4fs"
              % (n, st["bytes"], st["payload"], st["rate"], st["ch"], st["bits"], st["duration_s"]))
print("\n%d file(s), %d failed" % (len(sys.argv)-1, bad))
sys.exit(1 if bad else 0)
