#!/usr/bin/env bash
# Demo video voiceover with Amazon Polly (natural-sounding AWS text-to-speech).
#   npm run narration:polly                      # Stephen, generative engine
#   VOICE=Ruth npm run narration:polly           # other voices: Matthew, Ruth, Danielle, Gregory…
#   ENGINE=neural npm run narration:polly        # if generative isn't available for the voice/region
# Output: docs/video/polly-scene-1.mp3 … polly-scene-9.mp3 (+ polly-all-scenes.mp3).
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
  "Has anyone fed the cat? In every home with pets, that question gets asked every day, and the answer is usually a guess. So pets get fed twice, or they miss dinner, or their medication."
  "PetCheck fixes that with Alexa Plus. Anyone at home just says what they did. On the left is Alexa. On the right is the household's live view, the owner's phone."
  "Dad feeds Mochi and tells Alexa. It's logged for the whole house instantly. And you can see the real MCP calls PetCheck makes: initialize, list tools, then log care."
  "Ten minutes later, Emma doesn't know Dad already did it. PetCheck catches it. Dad already fed Mochi. No double dinner."
  "Now it's 7 PM, and nobody fed Biscuit. Every five minutes, an EventBridge schedule checks the routine. After thirty minutes, the house gets a reminder. After an hour, the owner gets an email, wherever they are."
  "Mom asks how Mochi's week went: meals, missed tasks, anything the family noted, and the next vet visit. Useful to bring to an appointment."
  "And PetCheck never plays vet. It records and reminds, and anything medical goes to your veterinarian."
  "Under the hood, PetCheck is an MCP server using streamable HTTP, running statelessly on AWS Lambda, with DynamoDB for storage, EventBridge Scheduler and SNS for alerts, and Amazon Bedrock to understand speech, with a built-in fallback. Even this narration is Amazon Polly. It's ready for real Alexa Plus: O-Auth account linking and the listing materials are done. Our account is still waiting on Amazon toolkit access, so this demo uses the simulated Alexa Plus, which calls the same live server."
  "No app to install, and nothing to remember to open. You just say what you did. PetCheck."
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
