// Netlify serverless function: instant, non-legal AI review of a pasted LOI.
// Requires an environment variable ANTHROPIC_API_KEY to be set in
// Netlify > Site configuration > Environment variables.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5"; // swap to "claude-haiku-4-5-20251001" for a cheaper/faster option

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Anthropic occasionally returns 429 (rate limited) or 529 (temporarily overloaded) — both are
// transient and usually succeed on a quick retry, so don't surface them to the user as a failure
// unless they persist across a few attempts.
async function callAnthropicWithRetry(requestBody, maxAttempts) {
  let lastResponse, lastErrText;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(requestBody)
    });

    if (response.ok || (response.status !== 429 && response.status !== 529)) {
      return response;
    }

    lastResponse = response;
    lastErrText = await response.text();
    console.error("Anthropic API returned", response.status, "on attempt", attempt, "of", maxAttempts, "- retrying:", lastErrText);

    if (attempt < maxAttempts) {
      await sleep(attempt * 800); // small backoff: 800ms, then 1600ms
    }
  }
  return lastResponse;
}

function buildSystemPrompt(perspective) {
  const isSeller = perspective === "seller";
  const isBuyer = perspective === "buyer";

  const perspectiveParagraph = isSeller
    ? `The person pasting this LOI is the SELLER in this transaction. Frame every consideration from the seller's point of view: things like whether the exclusivity/no-shop period is too long or too broad, whether purchase price mechanics (earnouts, holdbacks, adjustments) shift risk onto the seller, whether reps/warranties or indemnification terms expose the seller to outsized liability, deal-certainty and financing-contingency risk (i.e. is the buyer actually likely to close), and confidentiality of the seller's business information during diligence.`
    : isBuyer
    ? `The person pasting this LOI is the BUYER in this transaction. Frame every consideration from the buyer's point of view: things like whether the exclusivity period gives enough time to complete diligence, financing contingencies and deal-certainty protections for the buyer, purchase price adjustment mechanics, the scope of diligence access being granted, and conditions that need to be satisfied before the buyer is obligated to close.`
    : `The submitter did not specify whether they are the buyer or the seller — provide balanced, general considerations relevant to either side, and note where a term would matter differently depending on which side of the deal the reader is on.`;

  return `You are a general business-education assistant embedded in a law firm's marketing website (acquisition.law, run by Founders LLP, a Canadian M&A law firm).
A prospective client has pasted the text of a Letter of Intent (LOI) for a business acquisition. Your job is to produce a short, plain-English list of high-level things a business owner should think about or ask a lawyer about — NOT legal advice, NOT a legal opinion, and NOT a substitute for review by a licensed lawyer.

${perspectiveParagraph}

Rules:
- Do not state conclusions about enforceability, validity, or legality of any clause.
- Do not draft or suggest specific legal language.
- Do not give jurisdiction-specific legal advice.
- Focus on general, educational, non-legal business considerations relevant to the stated perspective above: things like whether provisions appear binding vs non-binding, exclusivity/no-shop periods, purchase price mechanics, financing contingencies, due diligence timelines, confidentiality, termination and break-up fee provisions, and other terms worth discussing with a lawyer.
- If the pasted text does not look like an LOI at all, say so briefly and still offer general educational notes on what a real LOI review would typically cover.
- Keep each item's summary to 1-3 sentences, plain English, no legal jargon.
- Produce 7 to 10 items, covering as many distinct, genuinely relevant considerations as the document supports. Do not pad with filler — every item should be a real, separate point worth raising.

Respond with ONLY valid JSON, no markdown code fences, no commentary, matching exactly this shape:
{"considerations": [{"category": "string", "summary": "string"}, ...], "overallNote": "string"}`;
}

exports.handler = async (event) => {
  console.log("review-loi invoked. Method:", event.httpMethod, "Body length:", (event.body || "").length);

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    console.error("Rejected: method not allowed:", event.httpMethod);
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  console.log("ANTHROPIC_API_KEY present?", Boolean(process.env.ANTHROPIC_API_KEY), "length:", (process.env.ANTHROPIC_API_KEY || "").length);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Rejected: missing ANTHROPIC_API_KEY environment variable.");
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Server is not configured. Missing ANTHROPIC_API_KEY." })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (err) {
    console.error("Rejected: could not parse request body as JSON:", event.body, err);
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const loiText = (payload.loiText || "").toString().trim();
  const pdfBase64 = (payload.pdfBase64 || "").toString().trim();
  const perspectiveRaw = (payload.perspective || "").toString().toLowerCase().trim();
  const perspective = (perspectiveRaw === "buyer" || perspectiveRaw === "seller") ? perspectiveRaw : "";
  console.log("Parsed loiText length:", loiText.length, "pdfBase64 length:", pdfBase64.length, "Perspective:", perspective || "(not specified)");

  if (!loiText && !pdfBase64) {
    console.error("Rejected: no loiText or pdfBase64 in payload:", JSON.stringify(payload).slice(0, 200));
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Please paste your LOI text or upload a file." }) };
  }

  // Defense in depth: reject an oversized base64 PDF even if the client-side size check was bypassed.
  const MAX_BASE64_CHARS = 6 * 1024 * 1024;
  if (pdfBase64 && pdfBase64.length > MAX_BASE64_CHARS) {
    console.error("Rejected: pdfBase64 too large:", pdfBase64.length);
    return { statusCode: 400, headers, body: JSON.stringify({ error: "That PDF is too large to process this way. Please try a smaller file or paste the text instead." }) };
  }

  // Cap input length to keep costs predictable and avoid abuse.
  const MAX_CHARS = 15000;
  const trimmedLoi = loiText.length > MAX_CHARS ? loiText.slice(0, MAX_CHARS) : loiText;

  // Build the message content: either a plain-text LOI, or — for scanned/image-only PDFs where
  // client-side text extraction came back empty — the PDF itself as a document Claude can read
  // directly with its vision capability (this works on scanned pages, unlike plain text extraction).
  const userContent = pdfBase64
    ? [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
        { type: "text", text: "The attached PDF is a Letter of Intent (LOI) for a business acquisition — it may be a scanned document. Please review it according to your instructions." }
      ]
    : `Here is the pasted LOI text:\n\n"""\n${trimmedLoi}\n"""`;

  try {
    console.log("Calling Anthropic API with model:", MODEL);
    const response = await callAnthropicWithRetry({
      model: MODEL,
      max_tokens: 4500,
      system: buildSystemPrompt(perspective),
      messages: [
        {
          role: "user",
          content: userContent
        }
      ]
    }, 3);

    console.log("Anthropic API responded with status:", response.status);

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", response.status, errText);
      const isOverloaded = response.status === 429 || response.status === 529;
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: isOverloaded
            ? "Our AI review service is experiencing high demand right now. Please try again in a moment."
            : "AI review service is temporarily unavailable."
        })
      };
    }

    const data = await response.json();
    console.log("Response stop_reason:", data.stop_reason, "Content block types:", Array.isArray(data.content) ? data.content.map(function (b) { return b && b.type; }) : typeof data.content);

    // Pull text out of every "text" content block rather than assuming content[0] is the text
    // (the response can include other block types, e.g. thinking blocks, before the text block).
    let rawText = "";
    if (Array.isArray(data.content)) {
      rawText = data.content
        .filter(function (block) { return block && block.type === "text" && typeof block.text === "string"; })
        .map(function (block) { return block.text; })
        .join("\n");
    }

    let parsed;
    try {
      // Strip accidental code fences just in case the model adds them.
      const cleaned = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
      try {
        parsed = JSON.parse(cleaned);
      } catch (e1) {
        // The model may have added a little preamble/commentary around the JSON
        // despite instructions not to — try pulling out just the {...} object.
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
        } else {
          throw e1;
        }
      }
    } catch (parseErr) {
      console.error("Failed to parse model output as JSON. Stop reason:", data.stop_reason, "Parse error:", parseErr.message, "Raw text was:", rawText);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: "Could not generate a structured review. Please try again.",
          debugStopReason: data.stop_reason,
          debugParseError: parseErr.message,
          debugRaw: rawText.slice(0, 4000),
          debugRawLength: rawText.length
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(parsed)
    };
  } catch (err) {
    console.error("Unexpected error calling Anthropic API:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Unexpected server error." })
    };
  }
};
