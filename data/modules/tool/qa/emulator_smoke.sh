#!/bin/bash
# QuizVerse emulator QA smoke — taps through the app, screenshots every stop,
# programmatic defect detection (blank / red-error / overflow stripes).
# Usage: bash tool/qa/emulator_smoke.sh [outdir]
set -u
ADB="$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe"
OUT="${1:-/c/Users/msi/qv-qa/shots}"
OUT_WIN=$(cygpath -w "$OUT" 2>/dev/null || echo "$OUT")
mkdir -p "$OUT"
DEV=emulator-5554

"$ADB" -s $DEV wait-for-device
SIZE=$("$ADB" -s $DEV shell wm size | tr -d '\r' | grep -oE '[0-9]+x[0-9]+' | tail -1)
W=${SIZE%x*}; H=${SIZE#*x}
echo "device=$DEV size=${W}x${H} out=$OUT"

shot() { # shot <name>
  "$ADB" -s $DEV shell screencap -p /sdcard/_qa.png
  "$ADB" -s $DEV pull /sdcard/_qa.png "$OUT_WIN\\$1.png" | tail -1
}
tap() { "$ADB" -s $DEV shell input tap "$1" "$2"; sleep "${3:-2}"; }
key() { "$ADB" -s $DEV shell input keyevent "$1"; sleep 1; }

# Nav bar geometry: 5 tabs evenly spaced, pill sits ~110px above bottom edge.
NAVY=$((H - 110))
TABX() { echo $(( W * $1 / 10 )); } # 1,3,5,7,9 for 5 tabs

echo '--- tap tour: 5 tabs ---'
shot 00_boot
tap "$(TABX 3)" "$NAVY" 3; shot 01_modes
tap "$(TABX 5)" "$NAVY" 3; shot 02_arena
tap "$(TABX 7)" "$NAVY" 3; shot 03_leaderboard
tap "$(TABX 9)" "$NAVY" 3; shot 04_profile
tap "$(TABX 1)" "$NAVY" 3; shot 05_home

echo '--- defect analysis (PIL) ---'
python - "$OUT_WIN" <<'PYEOF'
import sys, os
from PIL import Image
out = sys.argv[1]
for f in sorted(os.listdir(out)):
    if not f.endswith('.png'): continue
    im = Image.open(os.path.join(out, f)).convert('RGB')
    im.thumbnail((270, 585))
    px = list(im.getdata())
    n = len(px)
    # blank = one color covers >97%
    top = max(set(px), key=px.count)
    blank = px.count(top) / n
    # red error screen (Flutter debug error = strong red background)
    red = sum(1 for r, g, b in px if r > 150 and g < 70 and b < 70) / n
    # overflow chevrons (yellow/black stripes) — sample yellow ratio
    yellow = sum(1 for r, g, b in px if r > 200 and g > 180 and b < 60) / n
    flags = []
    if blank > 0.97: flags.append(f'BLANK({blank:.0%} {top})')
    if red > 0.30: flags.append(f'RED_ERROR({red:.0%})')
    if yellow > 0.005: flags.append(f'OVERFLOW_STRIPES({yellow:.2%})')
    print(f'{f}: {"; ".join(flags) if flags else "ok"}')
PYEOF

echo '--- flutter runtime errors (last run log tail) ---'
"$ADB" -s $DEV logcat -d -s flutter:E AndroidRuntime:E 2>/dev/null | tail -15
echo 'QA SMOKE DONE'
