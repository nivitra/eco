/** Loopback-only native client acceptance server. Never use this entrypoint for public deployment. */
if(process.env.NODE_ENV==='production')throw new Error('Local acceptance server refuses production mode');
process.env.HOST='127.0.0.1';process.env.INTERNAL_API='false';delete process.env.WORKER_DATABASE_URL;
await import('../src/server.js');
