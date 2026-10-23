#!/usr/bin/env bash
# Demo video voiceover with Amazon Polly (natural-sounding AWS text-to-speech).
#   npm run narration:polly                      # Stephen, generative engine
#   VOICE=Ruth npm run narration:polly           # other voices: Matthew, Ruth, Danielle, Gregory…
#   ENGINE=neural npm run narration:polly        # if generative isn't available for the voice/region
# Output: docs/video/polly-scene-1.mp3 … polly-scene-12.mp3 (+ polly-all-scenes.mp3).
# The same narration as scripts/video/make-video.mjs (which makes the whole video), for an Amazon Polly voice.
# Shot list for each scene: docs/submission/video-script.md
# Uses your default AWS CLI profile; needs polly:SynthesizeSpeech (AdministratorAccess covers it).
set -euo pipefail
cd "$(dirname "$0")/.."
export AWS_PAGER=""
VOICE="${VOICE:-Stephen}"
ENGINE="${ENGINE:-generative}"
REGION="${POLLY_REGION:-us-east-1}"
OUT=docs/video
mkdir -p "$OUT"

SCENES=(
  "Has anyone fed the cat? When several people share the pets, that question comes up every day, and the answer is usually a guess. So pets get fed twice, or miss dinner, or a dose of medicine."
  "PetCheck fixes that with Alexa Plus. Anyone at home just says what they did. On the left is Alexa; on the right, the family's live page."
  "Dad tells Alexa he fed Mochi. It's logged for the whole house, and here are the real MCP calls PetCheck makes."
  "Moments later, Emma doesn't know. PetCheck catches it: no double dinner."
  "A real AI model picks PetCheck's tools, so people can just talk. It logs the walk first, then answers from the updated log."
  "Now it's seven, and nobody has fed Biscuit. Every five minutes, PetCheck checks each pet's routine. Thirty minutes late, the house gets a reminder. An hour late, the owner gets an email."
  "And when nobody at home can do it, Alexa asks the neighborhood. Mom just says what she needs. The AI fills in a request form, takes the location from the device, and reads it back before posting."
  "Sam is a pet sitter a few streets away. He asks for jobs that suit him, and PetCheck filters by distance, pets, days and pay, skipping anything that clashes with his bookings."
  "He takes it, and the family sees who's coming. Sam's visits go into the same log, and a missed visit raises the same alerts."
  "And PetCheck never plays vet."
  "Under the hood, PetCheck is an MCP server over streamable HTTP, running statelessly on AWS Lambda with DynamoDB, EventBridge Scheduler and SNS. It works with any tool-calling model, and it's ready for real Alexa Plus: account linking and the listing are done."
  "Free for families, with a small fee on each visit booked through the care network. No app to install. You just say what you did. PetCheck."
)

synth() { # text, outfile, engine
  aws polly synthesize-speech --region "$REGION" --engine "$3" --voice-id "$VOICE" \
    --output-format mp3 --sample-rate 24000 --text "$1" "$2" >/dev/null
}

echo "Amazon Polly · voice $VOICE · engine $ENGINE · $REGION"
FILES=()
for i in "${!SCENES[@]}"; do
  n=$((i + 1))
  f="$OUT/polly-scene-$n.mp3"
  if ! synth "${SCENES[$i]}" "$f" "$ENGINE" 2>/tmp/polly.err; then
    if [ "$ENGINE" = "generative" ] && grep -qi "engine\|not supported\|ValidationException" /tmp/polly.err; then
      echo "  (generative not available for $VOICE here; using neural)"
      ENGINE=neural
      synth "${SCENES[$i]}" "$f" "$ENGINE"
    else
      cat /tmp/polly.err; exit 1
    fi
  fi
  FILES+=("$f")
  if command -v afinfo >/dev/null; then
    printf "  polly-scene-%s.mp3  %5ss\n" "$n" "$(afinfo "$f" | awk '/estimated duration/ {printf "%.1f", $3}')"
  else
    echo "  polly-scene-$n.mp3"
  fi
done

# Combined track for listening through (MP3 frames concatenate cleanly).
cat "${FILES[@]}" > "$OUT/polly-all-scenes.mp3"

CHARS=0; for s in "${SCENES[@]}"; do CHARS=$((CHARS + ${#s})); done
echo "✔ Done: ${#FILES[@]} scenes, $CHARS characters (a few cents at most)."
echo "  Listen: open $OUT/polly-all-scenes.mp3"
echo "  Other voices: VOICE=Ruth npm run narration:polly   (also Matthew, Danielle, Gregory)"
