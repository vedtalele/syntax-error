// Vercel serverless function: POST /api/ai   body: { agent: "planner", input: "..." }
// Keeps the Gemini key on the server. The browser never sees it.
const { AGENTS } = require('./_prompts');

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_INPUT = 20000; // characters, keeps free quota safe

// Pull JSON out of whatever the model returned (fences, extra text, etc.)
function extractJson(text) {
  if (!text) throw new Error('empty model reply');
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(s); } catch (_) {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error('no JSON found in model reply');
}

async function callGemini(system, userText, key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = new Error('Gemini error ' + r.status + ': ' + (await r.text()).slice(0, 300));
    err.status = r.status;
    throw err;
  }
  const data = await r.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  return parts ? parts.map(p => p.text || '').join('') : '';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use POST' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY is not set on the server' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const { agent, input } = body || {};
  const def = AGENTS[agent];
  if (!def) return res.status(400).json({ ok: false, error: 'Unknown agent: ' + agent });
  if (typeof input !== 'string' || !input.trim()) return res.status(400).json({ ok: false, error: 'input must be a non-empty string' });
  if (input.length > MAX_INPUT) return res.status(413).json({ ok: false, error: 'input too long' });

  const userText = def.label + ':\n' + input;
  let lastErr;
  // up to 3 tries: covers rate limits (429), server blips (5xx) and bad JSON
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await callGemini(def.system, userText, key);
      const json = extractJson(text);
      return res.status(200).json({ ok: true, agent, data: json });
    } catch (e) {
      lastErr = e;
      const retryable = !e.status || e.status === 429 || e.status >= 500;
      if (!retryable) break;
      await sleep(800 * (attempt + 1));
    }
  }
  return res.status(502).json({ ok: false, agent, error: String(lastErr && lastErr.message || lastErr) });
};

module.exports.extractJson = extractJson; // exported for tests
