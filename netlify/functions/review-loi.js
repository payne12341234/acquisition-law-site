// Netlify serverless function: instant, non-legal AI review of a pasted LOI.
// Requires an environment variable ANTHROPIC_API_KEY to be set in
// Netlify > Site configuration > Environment variables.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5"; // swap to "claude-haiku-4-5-20251001" for a cheaper/faster option

const SYSTEM_PROMPT = `You are a general business-education assistant embedded in a law firm's marketing website (acquisition.law, run by Founders LLP, a Canadian M&A law firm).
A prospective client has pasted the text of a Letter of Intent (LOI) for a business acquisition. Your job is to produce a short, plain-English list of high-level things a business owner should think about or ask a lawyer about — NOT legal advice, NOT a legal opinion, and NOT a substitute for review by a licensed lawyer.

Rules:
- Do not state conclusions about enforceability, validity, or legality of any clause.
- Do not draft or suggest specific legal language.
- Do not give jurisdiction-specific legal advice.
- Focus on general, educational, non-legal business considerations: things like whether provisions appear binding vs non-binding, exclusivity/no-shop periods, purchase price mechanics, financing contingencies, due diligence timelines, confidentiality, termination and break-up fee provisions, and other terms worth discussing with a lawyer.
- If the pasted text does not look like an LOI at all, say so briefly and still offer general educational notes on what a real LOI review would typically cover.
- Keep each item's summary to 1-3 sentences, plain English, no legal jargon.
- Produce 4 to 7 items.

Respond with ONLY valid JSON, no markdown code fences, no commentary, matching exactly this shape:
{"considerations": [{"category": "string", "summary": "string"}, ...], "overallNote": "string"}`;

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
  console.log("Parsed loiText length:", loiText.length);

  if (!loiText) {
    console.error("Rejected: loiText was empty after parsing payload:", JSON.stringify(payload).slice(0, 200));
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Please paste your LOI text." }) };
  }

  // Cap input length to keep costs predictable and avoid abuse.
  const MAX_CHARS = 15000;
  const trimmedLoi = loiText.length > MAX_CHARS ? loiText.slice(0, MAX_CHARS) : loiText;

  try {
    console.log("Calling Anthropic API with model:", MODEL);
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Here is the pasted LOI text:\n\n"""\n${trimmedLoi}\n"""`
          }
        ]
      })
    });

    console.log("Anthropic API responded with status:", response.status);

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", response.status, errText);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: "AI review service is temporarily unavailable." })
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
      console.error("Failed to parse model output as JSON. Raw text was:", rawText);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: "Could not generate a structured review. Please try again.", debugRaw: rawText.slice(0, 500) })
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
