// =============================================================================
// Recorder audio containers — PCM16 → WAV, bare Opus packets → Ogg Opus.
//
// Why containers at all
// --------------------
// The QuizVerse recorder ("Curio" pen) uploads *raw* audio: either PCM16 that
// the handset already decoded with libopus, or bare Opus packets straight off
// the BLE link. Neither is something a speech engine will accept — every ASR
// backend wants a demuxable file. So this file is the adapter, and it is
// deliberately the ONLY place that knows about byte layouts.
//
// Why this is not a native dependency
// -----------------------------------
// Nakama's runtime here is Goja (ES5), which has no FFI and no Node APIs, so
// "decode Opus on the server" is not available to us at any price. It turns out
// not to be needed: the ASR backend is ffmpeg-backed and accepts Ogg Opus, so
// the server only has to *containerise* the packets it is handed, never decode
// them. Containerising is pure integer work — a CRC32 table and some page
// headers — which is why it lives in TypeScript with no new dependency.
//
// Byte-safety rule that is load-bearing (do not "simplify" this)
// --------------------------------------------------------------
// Container bytes must never pass through a JS string. This runtime gives us no
// safe way to do it: `nk.binaryToString` refuses outright to convert a buffer
// that is not valid UTF-8 —
//
//     if !utf8.Valid(data.Bytes()) {
//         panic(r.NewTypeError("expects data to be UTF-8 encoded"))
//     }
//         — server/runtime_javascript_nakama.go
//
// and `nk.httpRequest` takes only a Go string, which re-encodes as UTF-8 and
// inflates every byte above 0x7F (measured: a 122,998-byte WAV became 252,532
// bytes). A WAV or an Ogg page is binary and fails that check essentially
// always; before the shim below existed, every upload of both codecs logged
// `provider failed: expects data to be UTF-8 encoded` against a real Nakama.
//
// So: assemble everything as a `Uint8Array` and never concatenate it as a
// string. The one conversion applied to a finished container is
// `nk.base64Encode`, which takes the ArrayBuffer directly and validates
// nothing, and the upload itself happens in a sidecar process
// (`deploy/recorder-asr-shim/shim.py`) — see recorder_asr_provider.ts.
//
// Note that base64 is not a shortcut past the muxing here: neither container
// can be assembled by concatenating base64. A WAV header is 44 bytes (not a
// multiple of 3, so it does not align to a base64 quantum), window trimming
// cuts chunks at arbitrary byte offsets, and Ogg pages carry a CRC computed
// over the page's own bytes. Real bytes are required, then encoded once.
// =============================================================================

namespace RecorderAudio {

  // ── Byte buffer helpers ───────────────────────────────────────────────────

  /** ASCII string → bytes. Throws on any non-ASCII input, which in this file
   *  would mean a header was built from user data by mistake. */
  export function asciiBytes(s: string): Uint8Array {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c > 0x7f) {
        throw new Error("asciiBytes: non-ASCII char at " + i + " (0x" + c.toString(16) + ")");
      }
      out[i] = c;
    }
    return out;
  }

  export function concatBytes(parts: Uint8Array[]): Uint8Array {
    var total = 0;
    var i: number;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], off);
      off += parts[i].length;
    }
    return out;
  }

  function writeU32LE(buf: Uint8Array, off: number, v: number): void {
    buf[off] = v & 0xff;
    buf[off + 1] = (v >>> 8) & 0xff;
    buf[off + 2] = (v >>> 16) & 0xff;
    buf[off + 3] = (v >>> 24) & 0xff;
  }

  function writeU16LE(buf: Uint8Array, off: number, v: number): void {
    buf[off] = v & 0xff;
    buf[off + 1] = (v >>> 8) & 0xff;
  }

  // ── WAV (RIFF/PCM) ────────────────────────────────────────────────────────

  /**
   * Wraps signed-16-bit little-endian PCM in a 44-byte canonical WAV header.
   *
   * `pcm` is passed through untouched — this never resamples or re-scales, so a
   * wrong `sampleRateHz` produces audio at the wrong speed rather than silence.
   * The rate therefore comes from the client's session metadata and is
   * validated by the caller against the Opus-legal set.
   */
  export function wavFromPcm16(pcm: Uint8Array, sampleRateHz: number, channels: number): Uint8Array {
    var byteRate = sampleRateHz * channels * 2;
    var header = new Uint8Array(44);
    header.set(asciiBytes("RIFF"), 0);
    writeU32LE(header, 4, 36 + pcm.length);
    header.set(asciiBytes("WAVEfmt "), 8);
    writeU32LE(header, 16, 16);          // fmt chunk size
    writeU16LE(header, 20, 1);           // WAVE_FORMAT_PCM
    writeU16LE(header, 22, channels);
    writeU32LE(header, 24, sampleRateHz);
    writeU32LE(header, 28, byteRate);
    writeU16LE(header, 32, channels * 2); // block align
    writeU16LE(header, 34, 16);           // bits per sample
    header.set(asciiBytes("data"), 36);
    writeU32LE(header, 40, pcm.length);
    return concatBytes([header, pcm]);
  }

  // ── Opus bitstream inspection ─────────────────────────────────────────────

  /** Frame duration in microseconds per TOC config number (RFC 6716 Table 2). */
  var CONFIG_FRAME_MICROS: number[] = [
    10000, 20000, 40000, 60000,
    10000, 20000, 40000, 60000,
    10000, 20000, 40000, 60000,
    10000, 20000, 10000, 20000,
    2500, 5000, 10000, 20000,
    2500, 5000, 10000, 20000,
    2500, 5000, 10000, 20000,
    2500, 5000, 10000, 20000,
  ];

  export interface OpusPacketInfo {
    config: number;
    frameMicros: number;
    frameCount: number;
    isStereo: boolean;
    durationMicros: number;
  }

  /**
   * Reads a packet's own TOC byte (RFC 6716 §3.1). This is the cheapest
   * available proof that we are pointed at real Opus, and it is the only
   * independent check on the packet size — see `sliceBarePackets`.
   *
   * Returns null rather than throwing, because it is called speculatively
   * while probing candidate packet sizes.
   */
  export function inspectOpusPacket(packet: Uint8Array): OpusPacketInfo {
    if (packet.length < 1) return null;
    var toc = packet[0];
    var config = (toc >> 3) & 0x1f;
    var isStereo = (toc & 0x04) !== 0;
    var code = toc & 0x03;
    var frameCount: number;
    if (code === 0) {
      frameCount = 1;
    } else if (code === 1 || code === 2) {
      frameCount = 2;
    } else {
      if (packet.length < 2) return null;
      frameCount = packet[1] & 0x3f;
      if (frameCount < 1) return null;
    }
    var micros = CONFIG_FRAME_MICROS[config];
    return {
      config: config,
      frameMicros: micros,
      frameCount: frameCount,
      isStereo: isStereo,
      durationMicros: micros * frameCount,
    };
  }

  /**
   * Splits a concatenated bare-Opus byte stream into fixed-size packets.
   *
   * The pen's real-time stream has no container and no length prefix, so the
   * packet boundary is implicit and recoverable only because the encoder is CBR
   * at a fixed packet size (40 bytes on the pnote pen, 80 on the RCSP sibling
   * family). A wrong size does NOT fail loudly on its own — libopus happily
   * decodes the first frame of a concatenated pair and drops the rest — so
   * every candidate slice is validated against its own TOC byte here, and the
   * caller is expected to prefer a candidate that validates cleanly and divides
   * the stream exactly.
   */
  export function sliceBarePackets(stream: Uint8Array, packetBytes: number): Uint8Array[] {
    var out: Uint8Array[] = [];
    var whole = Math.floor(stream.length / packetBytes);
    for (var i = 0; i < whole; i++) {
      out.push(stream.subarray(i * packetBytes, (i + 1) * packetBytes));
    }
    return out;
  }

  export interface PacketSizeGuess {
    packetBytes: number;
    packets: number;
    remainder: number;
    frameMicros: number;
    channels: number;
    /** True when every packet's TOC agreed and the stream divided exactly. */
    clean: boolean;
  }

  /**
   * Picks the packet size that the bytes themselves support.
   *
   * Checked against every candidate rather than assumed, because the client
   * does not currently send the packet size (see docs/recorder/ASR_ENDPOINTS.md
   * §"Client gap") and guessing wrong is the one error that produces plausible
   * audio at half the true length instead of an exception.
   */
  export function guessPacketSize(stream: Uint8Array, candidates: number[]): PacketSizeGuess {
    var best: PacketSizeGuess = null;
    for (var c = 0; c < candidates.length; c++) {
      var size = candidates[c];
      if (size <= 0 || stream.length < size) continue;
      var packets = sliceBarePackets(stream, size);
      var remainder = stream.length - packets.length * size;
      var ok = packets.length > 0;
      var micros = 0;
      var stereo = false;
      // Sample rather than scan: 50 packets/s means a long session is tens of
      // thousands of packets, and a wrong size shows up in the first few.
      var step = Math.max(1, Math.floor(packets.length / 64));
      for (var i = 0; i < packets.length && ok; i += step) {
        var info = inspectOpusPacket(packets[i]);
        if (info === null) { ok = false; break; }
        if (micros === 0) { micros = info.durationMicros; stereo = info.isStereo; }
        else if (info.durationMicros !== micros || info.isStereo !== stereo) { ok = false; break; }
      }
      var guess: PacketSizeGuess = {
        packetBytes: size,
        packets: packets.length,
        remainder: remainder,
        frameMicros: micros,
        channels: stereo ? 2 : 1,
        clean: ok && remainder === 0,
      };
      if (guess.clean) return guess;
      if (best === null || (ok && !best.clean)) best = guess;
    }
    return best;
  }

  // ── Ogg Opus muxing ───────────────────────────────────────────────────────

  var CRC_TABLE: number[] = null;

  /**
   * Ogg's CRC32: polynomial 0x04c11db7, MSB-first, no input/output reflection
   * and no final xor. It is NOT the zlib/PNG CRC32, and using that one produces
   * a file every demuxer rejects.
   */
  function crcTable(): number[] {
    if (CRC_TABLE !== null) return CRC_TABLE;
    var table: number[] = [];
    for (var i = 0; i < 256; i++) {
      var r = i << 24;
      for (var j = 0; j < 8; j++) {
        r = (r & 0x80000000) !== 0 ? ((r << 1) ^ 0x04c11db7) : (r << 1);
      }
      table.push(r >>> 0);
    }
    CRC_TABLE = table;
    return table;
  }

  function oggCrc(buf: Uint8Array): number {
    var table = crcTable();
    var crc = 0;
    for (var i = 0; i < buf.length; i++) {
      crc = ((crc << 8) ^ table[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
    }
    return crc >>> 0;
  }

  /** Lacing values for one page's segment table. Each packet is encoded as
   *  ceil(len/255) bytes; a packet whose length is a multiple of 255 needs an
   *  explicit terminating 0 or the demuxer will wait for a continuation. */
  function lacing(lengths: number[]): number[] {
    var segs: number[] = [];
    for (var i = 0; i < lengths.length; i++) {
      var n = lengths[i];
      while (n >= 255) { segs.push(255); n -= 255; }
      segs.push(n);
    }
    return segs;
  }

  function oggPage(
    headerType: number,
    granulePos: number,
    serial: number,
    pageSeq: number,
    packets: Uint8Array[],
  ): Uint8Array {
    var lengths: number[] = [];
    var i: number;
    for (i = 0; i < packets.length; i++) lengths.push(packets[i].length);
    var segs = lacing(lengths);
    if (segs.length > 255) throw new Error("oggPage: " + segs.length + " lacing values exceeds 255");

    var payloadLen = 0;
    for (i = 0; i < packets.length; i++) payloadLen += packets[i].length;

    var page = new Uint8Array(27 + segs.length + payloadLen);
    page.set(asciiBytes("OggS"), 0);
    page[4] = 0;                       // stream structure version
    page[5] = headerType & 0xff;
    // granule position is 64-bit LE. Opus granules count 48 kHz samples, so a
    // 32-bit low word covers ~24 h of audio — the high word is written from the
    // float division rather than left at zero so a long session cannot wrap.
    writeU32LE(page, 6, granulePos >>> 0);
    writeU32LE(page, 10, Math.floor(granulePos / 4294967296));
    writeU32LE(page, 14, serial);
    writeU32LE(page, 18, pageSeq);
    writeU32LE(page, 22, 0);           // CRC placeholder — computed over zeros
    page[26] = segs.length;
    for (i = 0; i < segs.length; i++) page[27 + i] = segs[i];
    var off = 27 + segs.length;
    for (i = 0; i < packets.length; i++) {
      page.set(packets[i], off);
      off += packets[i].length;
    }
    writeU32LE(page, 22, oggCrc(page));
    return page;
  }

  /** RFC 7845 §5.1 ID header. */
  function opusHead(channels: number, sampleRateHz: number, preSkip: number): Uint8Array {
    var h = new Uint8Array(19);
    h.set(asciiBytes("OpusHead"), 0);
    h[8] = 1;                          // version
    h[9] = channels & 0xff;
    writeU16LE(h, 10, preSkip);
    writeU32LE(h, 12, sampleRateHz);   // original input rate, informational
    writeU16LE(h, 16, 0);              // output gain
    h[18] = 0;                         // channel mapping family 0
    return h;
  }

  /** RFC 7845 §5.2 comment header. */
  function opusTags(): Uint8Array {
    var vendor = asciiBytes("quizverse-recorder-asr");
    var t = new Uint8Array(8 + 4 + vendor.length + 4);
    t.set(asciiBytes("OpusTags"), 0);
    writeU32LE(t, 8, vendor.length);
    t.set(vendor, 12);
    writeU32LE(t, 12 + vendor.length, 0); // zero user comments
    return t;
  }

  export interface OggOpusResult {
    bytes: Uint8Array;
    packets: number;
    durationMs: number;
  }

  /**
   * Muxes bare Opus packets into a single-stream Ogg Opus file.
   *
   * `preSkip` is left at libopus's default 312 samples @48 kHz; it only affects
   * the first ~6.5 ms of output, and the pen's stream has no encoder delay
   * metadata for us to do better with.
   */
  export function oggOpusFromPackets(
    packets: Uint8Array[],
    sampleRateHz: number,
    channels: number,
    frameMicros: number,
    serial: number,
  ): OggOpusResult {
    if (packets.length === 0) throw new Error("oggOpusFromPackets: no packets");
    var preSkip = 312;
    var pages: Uint8Array[] = [];
    var seq = 0;
    pages.push(oggPage(0x02, 0, serial, seq++, [opusHead(channels, sampleRateHz, preSkip)]));
    pages.push(oggPage(0x00, 0, serial, seq++, [opusTags()]));

    // Granule positions are in 48 kHz samples regardless of the decode rate
    // (RFC 7845 §4), so the per-packet advance is derived from the frame
    // duration, not from sampleRateHz.
    var granulePerPacket = Math.round(frameMicros * 48000 / 1000000);
    var granule = preSkip;
    var i = 0;
    // Batch packets per page, staying under both the 255-lacing-value limit and
    // Ogg's ~64 KiB practical page size.
    var PER_PAGE = 50;
    while (i < packets.length) {
      var batch: Uint8Array[] = [];
      var bytes = 0;
      while (i < packets.length && batch.length < PER_PAGE && bytes < 48000) {
        batch.push(packets[i]);
        bytes += packets[i].length + 1;
        granule += granulePerPacket;
        i++;
      }
      var last = i >= packets.length;
      pages.push(oggPage(last ? 0x04 : 0x00, granule, serial, seq++, batch));
    }
    return {
      bytes: concatBytes(pages),
      packets: packets.length,
      durationMs: Math.round(packets.length * frameMicros / 1000),
    };
  }

}
