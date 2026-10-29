#!/usr/bin/env bash
# Encode outpaint outputs for the web and grab a poster frame for each.
#
#   scripts/prepare_media.sh [SOURCE_DIR]   (default: ../outpaint_vids)
#
# Reads <name>_source_<ar>_out.mp4 and writes media/<name>.mp4 (long side
# 1280px, H.264, faststart) and media/posters/<name>.jpg. Only outputs are
# encoded: the page's "Original" view masks the output down to the source
# frame, which the outpainter leaves untouched.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC_DIR="${1:-../outpaint_vids}"
mkdir -p media/posters

for f in "$SRC_DIR"/*_out.mp4; do
  name="$(basename "$f" .mp4)"
  name="${name%_source_*}"
  out="media/${name}.mp4"
  poster="media/posters/${name}.jpg"
  scale="scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)'"

  if [[ ! -f "$out" ]]; then
    echo "encode  $name"
    ffmpeg -v error -y -i "$f" -vf "$scale" \
      -c:v libx264 -preset medium -crf 23 -profile:v high -pix_fmt yuv420p \
      -c:a aac -b:a 128k -movflags +faststart "$out"
  fi
  if [[ ! -f "$poster" ]]; then
    dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")"
    at="$(awk -v d="$dur" 'BEGIN { printf "%.2f", d / 3 }')"
    ffmpeg -v error -y -ss "$at" -i "$f" -frames:v 1 -vf "$scale" -q:v 4 "$poster"
  fi
done
