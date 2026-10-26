// Execute inside the private ops container: node ops/operator.mjs METHOD /v1/ops/path '{...}'
const [method, path, body] = process.argv.slice(2);
if (!method || !path?.startsWith('/v1/ops/')) throw new Error('Usage: METHOD /v1/ops/path [JSON]');
const { request } = await import('node:http');
const req = request(
  {
    hostname: '127.0.0.1',
    port: Number(process.env.PORT || 3000),
    path,
    method,
    timeout: 30000,
    headers: {
      Host: new URL(process.env.PUBLIC_URL).host,
      'X-Ops-Token': process.env.OPS_TOKEN,
      'Content-Type': 'application/json',
      ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
    },
  },
  (response) => {
    let size = 0;
    const chunks = [];
    response.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        response.destroy(new Error('Operator response exceeded limit'));
        return;
      }
      chunks.push(chunk);
    });
    response.once('end', () => {
      console.log(Buffer.concat(chunks).toString('utf8'));
      process.exitCode = response.statusCode >= 200 && response.statusCode < 300 ? 0 : 1;
    });
    response.once('error', () => {
      console.error('Operator response interrupted');
      process.exitCode = 1;
    });
  },
);
req.once('timeout', () => req.destroy(new Error('Operator request timed out')));
req.once('error', () => {
  console.error('Private operator service unavailable');
  process.exitCode = 1;
});
req.end(body);
