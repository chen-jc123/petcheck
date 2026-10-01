# PetCheck: Alexa+ add-on listing

Copy these into `addon-package/addon.json` after `alexa-ai new mcp` (step 3).
Character limits from the Alexa+ MCP Toolkit docs are checked by `npm run check:listing`.

## Name
PetCheck

## Short description (≤ 123 characters)
One shared pet care log for your household: tell Alexa what you did, and everyone knows what's done or still due.

## Full description (≤ 4000 characters)
"Has anyone fed the cat?" PetCheck answers that question for the whole household.

Anyone at home just tells Alexa what they did: "I fed Mochi", "I walked Biscuit", "I gave Biscuit his joint supplement". PetCheck keeps one shared log, so everyone can ask "Has anyone walked Biscuit?" or "What's left for Mochi today?" and get a straight answer.

PetCheck catches double feedings. If Emma says "I fed Mochi" ten minutes after Dad did, Alexa says "Dad already fed Mochi at 7:52 AM. Log it again?" so pets don't get fed twice.

Nothing slips through. If dinner or a dose of medication isn't logged, PetCheck reminds the household after 30 minutes and emails the owner after an hour.

Ask "How's Mochi doing this week?" for a summary of meals, walks, medication, anything you noted (like "Mochi threw up this morning") and the next vet visit, handy to bring to an appointment.

What you can say:
• "I fed Mochi" / "I walked the dog" / "I cleaned the litter box"
• "Has anyone fed the cat?" / "What's left for Biscuit today?"
• "Mochi threw up this morning" (recorded as a note)
• "Book Mochi's checkup next Tuesday at 10"
• "How's Mochi doing this week?"

PetCheck records and reminds. It never gives veterinary advice: questions about symptoms, doses or food safety get "please check with your vet."

To link PetCheck, open the add-on in the Alexa app and enter your household key.

## Example phrases (3–4, ≤ 200 characters each)
1. Alexa, I fed Mochi.
2. Alexa, has anyone walked Biscuit?
3. Alexa, how's Mochi doing this week?
4. Alexa, Mochi threw up this morning.

## Links
- Privacy policy: https://3evhjm62gfamojobakfx6plqty0bsdqq.lambda-url.us-east-1.on.aws/privacy
- Terms of use:   https://3evhjm62gfamojobakfx6plqty0bsdqq.lambda-url.us-east-1.on.aws/terms

## Media (in alexa/assets/)
| File | Size | Use |
|---|---|---|
| icon-72.png | 72×72 | icon |
| icon-64.png | 64×64 | icon |
| icon-88.png | 88×88 | icon |
| icon-126.png | 126×126 | icon |
| icon-180.png | 180×180 | icon |
| icon-241.png | 241×241 | icon |
| carousel-600x900.png | 600×900 | carousel image |
| icon.svg, icon-512.png, carousel.html | — | design sources (vector icon, large icon, carousel layout) |

## Distribution
Countries: `["US"]` · Locale: `en-US`

## Account linking (OAuth 2.1, see src/oauth.ts)
- Authorization server metadata: `<URL>/.well-known/oauth-authorization-server`
- Authorization endpoint: `<URL>/oauth/authorize` · Token endpoint: `<URL>/oauth/token`
- Client ID: `alexa-petcheck` · Client secret: `OAUTH_CLIENT_SECRET` in `.env.deploy` (never commit it)
- Scopes: `mcp:service` (client credentials), `mcp:tools` (authorization code + PKCE S256)
