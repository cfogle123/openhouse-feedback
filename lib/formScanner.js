// Reads a photo of a paper open-house feedback form (handwritten or
// printed) via Claude's vision API and pulls out structured fields, so an
// agent can snap a picture instead of retyping a stack of forms by hand.
// This NEVER saves anything on its own -- the extracted fields are handed
// back to the browser to pre-fill the normal "Log New Entry" form, so the
// agent still reviews and confirms (or corrects) everything, especially
// phone numbers and emails, before it's actually submitted.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
// Configurable via env var in case Anthropic ships a newer vision-capable
// model later and you'd rather point at that one without a code change.
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

function isFormScannerConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const EXTRACTION_PROMPT = `This is a photo of a single handwritten or printed open-house visitor feedback form. Extract these fields and respond with ONLY a JSON object, no markdown fences, no explanation:

{
  "buyerName": string or null,
  "buyerPhone": string or null,
  "buyerEmail": string or null,
  "interested": "Yes" or "No" or null,
  "hasAgent": true or false or null,
  "buyerAgentName": string or null,
  "feedback": string or null,
  "address": string or null
}

Rules:
- If a field is illegible or not present on the form, use null for it -- never guess.
- "interested" should reflect whether the visitor marked/circled/checked that they're interested in the home.
- "hasAgent" should be true only if the form clearly indicates the buyer already has a real estate agent.
- For buyerPhone, only include digits you can read with confidence; prefer null over a possibly-wrong number.
- "feedback" is any freeform notes/comments written on the form.
- "address" is the open house's address if it's written on the form itself.
- Respond with ONLY the JSON object.`;

async function scanFeedbackForm(imageBuffer, mimeType) {
  if (!isFormScannerConfigured()) {
    const err = new Error('ANTHROPIC_API_KEY not set');
    err.notConfigured = true;
    throw err;
  }

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBuffer.toString('base64') } },
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 300)}`);
  }

  const body = await res.json();
  const textBlock = (body.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text content in the vision API response');

  // Claude might still occasionally wrap the JSON in a code fence despite
  // being told not to -- strip that defensively rather than failing outright.
  const cleaned = textBlock.text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Could not parse a valid JSON response from the scan: ' + e.message);
  }

  return {
    buyerName: parsed.buyerName || '',
    buyerPhone: parsed.buyerPhone || '',
    buyerEmail: parsed.buyerEmail || '',
    interested: parsed.interested === 'Yes' || parsed.interested === 'No' ? parsed.interested : '',
    hasAgent: Boolean(parsed.hasAgent),
    buyerAgentName: parsed.buyerAgentName || '',
    feedback: parsed.feedback || '',
    address: parsed.address || '',
  };
}

module.exports = { isFormScannerConfigured, scanFeedbackForm };
