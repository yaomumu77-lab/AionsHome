import worker from './xhs_lite_worker.js';

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

const main = async () => {
  let payload = {};
  const raw = await readStdin();
  if (raw.trim()) payload = JSON.parse(raw);

  const endpoint = String(payload.endpoint || 'health').replace(/^\/+|\/+$/g, '');
  const method = endpoint === 'health' ? 'GET' : 'POST';
  const headers = new Headers({ 'content-type': 'application/json' });
  if (payload.cookie) headers.set('x-xhs-cookie', String(payload.cookie));

  const request = new Request(`http://xhs-lite.local/api/${endpoint}`, {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(payload.body || {}) : undefined,
  });
  const response = await worker.fetch(request, {}, {});
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  process.stdout.write(JSON.stringify({
    status: response.status,
    ok: response.ok,
    data,
  }));
};

main().catch((error) => {
  process.stdout.write(JSON.stringify({
    status: 500,
    ok: false,
    data: { error: error?.message || String(error) },
  }));
  process.exitCode = 1;
});
