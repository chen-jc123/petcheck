#!/usr/bin/env bash
# Generate the demo video's voiceover with macOS's built-in text-to-speech.
#   bash scripts/make-narration.sh            # pick a voice automatically
#   VOICE="Daniel" bash scripts/make-narration.sh
# Output: docs/video/scene-1.m4a … scene-9.m4a (+ all-scenes.m4a), ready for iMovie.
# The text is spelled for speech (e.g. "A W S", "O-Auth"); the on-screen script is in the chat/README.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v say >/dev/null || { echo "✖ This script needs macOS (the 'say' command)."; exit 1; }

OUT=docs/video
mkdir -p "$OUT"
RATE="${RATE:-178}"   # words per minute; lower = slower

# A clear English voice that differs from the simulated Alexa's (Samantha).
if [ -z "${VOICE:-}" ]; then
  AVAILABLE=$(say -v '?' | sed -E 's/ +[a-z]{2}_[A-Z]{2} +#.*//')
  for v in "Evan (Enhanced)" "Nathan (Enhanced)" "Tom (Enhanced)" "Alex" "Evan" "Nathan" "Aaron" "Tom" "Daniel" "Fred"; do
    if grep -qxF "$v" <<<"$AVAILABLE"; then VOICE="$v"; break; fi
  done
fi
VOICE="${VOICE:-}"
echo "Voice: ${VOICE:-system default} · ${RATE} wpm"

SCENES=(
  "Has anyone fed the cat? In every home with pets, that question gets asked every day, and the answer is usually a guess. So pets get fed twice, or they miss dinner, or their medication."
  "PetCheck fixes that with Alexa plus. Anyone at home just says what they did. On the left is Alexa. On the right is the household's live view, the owner's phone."
  "Dad feeds Mochi and tells Alexa. It's logged for the whole house instantly. And you can see the real M C P calls PetCheck makes: initialize, list tools, then log care."
  "Ten minutes later, Emma doesn't know Dad already did it. PetCheck catches it. Dad already fed Mochi. No double dinner."
  "Now it's seven P M, and nobody fed Biscuit. Every five minutes, an Event Bridge schedule checks the routine. After thirty minutes the house gets a reminder. After an hour, the owner gets an email, wherever they are."
  "Mom asks how Mochi's week went: meals, missed tasks, anything the family noted, and the next vet visit. Useful to bring to an appointment."
  "And PetCheck never plays vet. It records and reminds, and anything medical goes to your veterinarian."
  "Under the hood, PetCheck is an M C P server using streamable H T T P, running statelessly on A W S Lambda, with Dynamo D B for storage, Event Bridge Scheduler and S N S for alerts, and Amazon Bedrock to understand speech, with a built-in fallback. It's ready for real Alexa plus. O-Auth account linking and the listing materials are done. Our account is still waiting on Amazon toolkit access, so this demo uses the simulated Alexa plus, which calls the same live server."
  "No app to install, and nothing to remember to open. You just say what you did. PetCheck."
)

TOTAL=0
LIST=()
for i in "${!SCENES[@]}"; do
  n=$((i + 1))
  AIFF="$OUT/scene-$n.aiff"
  if [ -n "$VOICE" ]; then say -v "$VOICE" -r "$RATE" -o "$AIFF" "${SCENES[$i]}"; else say -r "$RATE" -o "$AIFF" "${SCENES[$i]}"; fi
  afconvert -f m4af -d aac "$AIFF" "$OUT/scene-$n.m4a" && rm -f "$AIFF"
  SECS=$(afinfo "$OUT/scene-$n.m4a" | awk '/estimated duration/ {printf "%.1f", $3}')
  TOTAL=$(awk -v a="$TOTAL" -v b="$SECS" 'BEGIN { printf "%.1f", a + b }')
  LIST+=("$OUT/scene-$n.m4a")
  printf "  scene-%s.m4a  %5ss\n" "$n" "$SECS"
done

# One combined track too (scenes back to back, with a short pause between them).
COMBINED_TEXT=""
for s in "${SCENES[@]}"; do COMBINED_TEXT+="$s [[slnc 700]] "; done
if [ -n "$VOICE" ]; then say -v "$VOICE" -r "$RATE" -o "$OUT/all-scenes.aiff" "$COMBINED_TEXT"; else say -r "$RATE" -o "$OUT/all-scenes.aiff" "$COMBINED_TEXT"; fi
afconvert -f m4af -d aac "$OUT/all-scenes.aiff" "$OUT/all-scenes.m4a" && rm -f "$OUT/all-scenes.aiff"

echo "✔ Narration total: ${TOTAL}s (the video must be under 180s including pauses)."
echo "  Files are in $OUT/. Listen: open $OUT/all-scenes.m4a"
echo "  Try another voice: VOICE=\"Daniel\" bash scripts/make-narration.sh   (list voices: say -v '?')"
