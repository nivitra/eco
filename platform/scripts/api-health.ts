import { get } from 'node:http';
// Use node:http: fetch implementations may rewrite Host to the connection origin.
const request = get(
  {
    hostname: '127.0.0.1',
    port: Number(process.env.PORT || 3000),
    path: '/health/ready',
    headers: { host: new URL(process.env.PUBLIC_URL!).host },
    timeout: 3500,
  },
  (response) => {
    response.resume();
    response.once('end', () => process.exit(response.statusCode === 200 ? 0 : 1));
  },
);
request.once('timeout', () => request.destroy(new Error('Health check timed out')));
request.once('error', () => process.exit(1));
