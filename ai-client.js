// Browser helper. Usage:  const out = await callAI('planner', briefText);
// Returns the parsed JSON from the agent, or throws an Error.
async function callAI(agent, input) {
  const r = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, input }),
  });
  let j;
  try { j = await r.json(); } catch (_) { throw new Error('Server returned a non-JSON reply (status ' + r.status + ')'); }
  if (!j.ok) throw new Error(j.error || 'AI call failed');
  return j.data;
}
window.callAI = callAI;
