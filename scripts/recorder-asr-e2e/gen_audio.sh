#!/usr/bin/env bash
# Generates the two real-audio fixtures the e2e driver pushes:
#   speech.pcm       16 kHz mono s16le raw PCM  -> the `pcm16` client path
#   speech.bareopus  concatenated bare Opus packets, no container, no length
#                    prefix -> the `opus` client path (what the pen emits)
set -euo pipefail
cd "$(dirname "$0")"

SCRIPT="One. This is the Curio recorder speaking through the sidecar shim.
Two. The audio was captured on the device and sent to Nakama as base sixty four.
Three. The server wrapped it in a container and asked the whisper engine for text.
Four. Windowing means each push transcribes about eight seconds of new audio.
Five. The overlap prevents a sentence from being cut in half at the seam.
Six. If this transcript reads correctly then device audio has become text."

echo "$SCRIPT" > script.txt
say -r 165 -o speech.aiff "$SCRIPT"

# Reference WAV (what the engine would ideally see) + raw PCM for the pcm16 path.
ffmpeg -y -loglevel error -i speech.aiff -ac 1 -ar 16000 -c:a pcm_s16le speech16k.wav
ffmpeg -y -loglevel error -i speech16k.wav -f s16le -acodec pcm_s16le speech.pcm

# Ogg Opus at a fixed bitrate with VBR off and 20 ms frames, which is what makes
# every packet the same size — the pen is a CBR encoder and the bare stream is
# only recoverable because of that. 16 kbit/s * 20 ms = 40 bytes/packet, the
# documented pnote pen packet size.
ffmpeg -y -loglevel error -i speech16k.wav -c:a libopus -b:a 16k -vbr off \
  -frame_duration 20 -ar 16000 -ac 1 speech.opus.ogg

python3 ogg_to_bare.py speech.opus.ogg speech.bareopus

ls -l speech.pcm speech.bareopus speech16k.wav speech.opus.ogg
ffprobe -v error -show_entries format=duration -of default=nw=1 speech16k.wav
