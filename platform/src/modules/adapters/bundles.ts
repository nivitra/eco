import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { HttpError, canonical } from '../../db.js';
export const RENDERER_VERSION = 'kulture-static-fragment-v1';
export const TEMPLATE_HASH = createHash('sha256')
  .update('kulture-static-fragment-v1:escaped-semantic-html:2026-09-29')
  .digest('hex');
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export interface BundleEnvelope {
  algorithm: 'Ed25519';
  keyID: string;
  payloadBytes: string;
  payloadDigest: string;
  detachedSignature: string;
}
export function trustedSigningKeys(): Record<string, string> {
  try {
    return JSON.parse(process.env.PUBLICATION_TRUSTED_KEYS_JSON ?? '{}');
  } catch {
    throw new HttpError(503, 'signing_config', 'Publication public-key configuration is invalid');
  }
}
export function signBundle(payload: Record<string, unknown>): BundleEnvelope {
  const pem = process.env.PUBLICATION_SIGNING_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    keyID = process.env.PUBLICATION_SIGNING_KEY_ID;
  if (!pem || !keyID)
    throw new HttpError(
      503,
      'signing_unavailable',
      'Publication signing must be configured before WordPress delivery',
    );
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519')
    throw new HttpError(503, 'signing_config', 'Publication key must be Ed25519');
  const bytes = Buffer.from(canonical(payload), 'utf8'),
    publicPEM = trustedSigningKeys()[keyID];
  if (
    !publicPEM ||
    createPublicKey(publicPEM)
      .export({ type: 'spki', format: 'der' })
      .compare(createPublicKey(key).export({ type: 'spki', format: 'der' })) !== 0
  )
    throw new HttpError(
      503,
      'signing_config',
      'Active signing key must be present in the trusted keyring',
    );
  if ((process.env.PUBLICATION_REVOKED_KEY_IDS ?? '').split(',').includes(keyID))
    throw new HttpError(503, 'key_revoked', 'The active publication signing key was revoked');
  return {
    algorithm: 'Ed25519',
    keyID,
    payloadBytes: bytes.toString('base64'),
    payloadDigest: sha256(bytes),
    detachedSignature: sign(null, bytes, key).toString('base64'),
  };
}
export function verifyBundle(
  envelope: BundleEnvelope,
  keys = trustedSigningKeys(),
): Record<string, any> {
  if (
    envelope.algorithm !== 'Ed25519' ||
    !keys[envelope.keyID] ||
    (process.env.PUBLICATION_REVOKED_KEY_IDS ?? '').split(',').includes(envelope.keyID)
  )
    throw new HttpError(422, 'untrusted_key', 'Publication signing key is not trusted');
  const bytes = Buffer.from(envelope.payloadBytes, 'base64');
  if (
    bytes.length > 1000000 ||
    sha256(bytes) !== envelope.payloadDigest ||
    !verify(
      null,
      bytes,
      createPublicKey(keys[envelope.keyID]),
      Buffer.from(envelope.detachedSignature, 'base64'),
    )
  )
    throw new HttpError(422, 'invalid_signature', 'Publication signature is invalid');
  return JSON.parse(bytes.toString('utf8'));
}
