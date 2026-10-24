// Vercel serverless function: POST /api/ai   body: { agent: "planner", input: "..." }
// Keeps the Gemini key on the server. The browser never sees it.
const { AGENTS, SHAPE } = require('./_prompts');

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_INPUT = 20000;

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
  const generationConfig = { temperature: 0.2, maxOutputTokens: 8192, responseMimeType: 'application/json' };
  // 2.5 models "think" first, which is slow and can eat the output budget. Turn it off for speed.
  if (/2\.5/.test(MODEL) && /flash/.test(MODEL)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig,
    }),
  });
  if (!r.ok) {
    const err = new Error('Gemini error ' + r.status + ': ' + (await r.text()).slice(0, 300));
    err.status = r.status;
    throw err;
  }
  const data = await r.json();
  const cand = data.candidates && data.candidates[0];
  if (!cand) {
    const why = data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error('Gemini returned no answer' + (why ? ' (blocked: ' + why + ')' : ''));
  }
  const parts = cand.content && cand.content.parts;
  const text = parts ? parts.map(p => p.text || '').join('') : '';
  if (cand.finishReason === 'MAX_TOKENS') throw new Error('model reply was cut off');
  return text;
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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await callGemini(def.system, userText, key);
      const json = extractJson(text);
      if (SHAPE[agent] && !SHAPE[agent](json)) throw new Error('model reply had the wrong shape');
      return res.status(200).json({ ok: true, agent, data: json });
    } catch (e) {
      lastErr = e;
      const retryable = !e.status || e.status === 429 || e.status >= 500;
      if (!retryable) break;
      await sleep(600 * (attempt + 1));
    }
  }
  return res.status(502).json({ ok: false, agent, error: String(lastErr && lastErr.message || lastErr) });
};

module.exports.extractJson = extractJson;
