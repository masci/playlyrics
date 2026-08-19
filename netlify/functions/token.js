'use strict';

// Uses the Web Crypto API (Node 18+) instead of createSign to avoid OpenSSL
// decoder issues when the private key PEM arrives from an env var.
const { webcrypto } = require('crypto');

exports.handler = async () => {
  const teamId     = process.env.APPLE_TEAM_ID;
  const keyId      = process.env.APPLE_KEY_ID;
  const privateKey = process.env.APPLE_PRIVATE_KEY;

  if (!teamId || !keyId || !privateKey) {
    return fail(
      'Apple Music credentials not configured. ' +
      'Set APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY in Netlify environment variables.'
    );
  }

  try {
    const token = await buildToken(teamId, keyId, privateKey);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=3600',
      },
      body: JSON.stringify({ token }),
    };
  } catch (err) {
    return fail('Failed to sign token: ' + err.message);
  }
};

async function buildToken(teamId, keyId, rawPem) {
  const { subtle } = webcrypto;

  // Netlify may store multiline env vars with literal \n sequences.
  const pem = rawPem.replace(/\\n/g, '\n');

  // Strip PEM headers and whitespace to get raw DER bytes.
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const keyBytes = Buffer.from(b64, 'base64');

  // subtle.importKey with 'pkcs8' is explicit about the key format and avoids
  // the OpenSSL decoder path that causes the "unsupported" error.
  const cryptoKey = await subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const now     = Math.floor(Date.now() / 1000);
  const header  = toBase64Url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = toBase64Url(JSON.stringify({ iss: teamId, iat: now, exp: now + 15897600 }));
  const message = `${header}.${payload}`;

  // Web Crypto ECDSA returns IEEE P1363 (raw R||S) directly — exactly what JWT ES256 needs.
  const sigBytes  = await subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    cryptoKey,
    Buffer.from(message)
  );

  const signature = Buffer.from(sigBytes).toString('base64url');
  return `${message}.${signature}`;
}

function toBase64Url(str) {
  return Buffer.from(str).toString('base64url');
}

function fail(message) {
  return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message }),
  };
}
