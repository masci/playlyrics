'use strict';

const { createSign } = require('crypto');

// Generates a short-lived Apple MusicKit developer token (ES256 JWT).
// Required env vars: APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (PEM content of the .p8 file).
exports.handler = async () => {
  const teamId     = process.env.APPLE_TEAM_ID;
  const keyId      = process.env.APPLE_KEY_ID;
  const privateKey = process.env.APPLE_PRIVATE_KEY;

  if (!teamId || !keyId || !privateKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Apple Music credentials not configured. Set APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY in Netlify environment variables.',
      }),
    };
  }

  // Netlify env vars sometimes store literal \n instead of real newlines.
  const pem = privateKey.replace(/\\n/g, '\n');

  const now = Math.floor(Date.now() / 1000);
  // Max token lifetime Apple allows is 6 months (15897600 s).
  const exp = now + 15897600;

  const header  = toBase64Url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = toBase64Url(JSON.stringify({ iss: teamId, iat: now, exp }));
  const message = `${header}.${payload}`;

  let signature;
  try {
    const signer = createSign('SHA256');
    signer.update(message);
    // ieee-p1363 gives raw R||S bytes (what JWT ES256 requires), not DER.
    signature = signer.sign({ key: pem, dsaEncoding: 'ieee-p1363' }, 'base64url');
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to sign token: ' + err.message }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      // Cache for 1 hour — well within the 6-month token lifetime.
      'Cache-Control': 'private, max-age=3600',
    },
    body: JSON.stringify({ token: `${message}.${signature}` }),
  };
};

function toBase64Url(str) {
  return Buffer.from(str).toString('base64url');
}
