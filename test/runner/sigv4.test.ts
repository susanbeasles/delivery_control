import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalQuery, signV4, signingKey, toAmzDate, UNSIGNED_PAYLOAD } from '../../worker/runner/egress/sigv4.ts';
import { toHex } from '../../worker/lib/json.ts';

// Known-answer tests. Inputs and outputs are the published AWS examples, hard-coded:
// - "get-vanilla" from the AWS SigV4 test suite (service "service", region us-east-1).
// - "GET Object" from the Amazon S3 API reference, "Signature Calculations for the Authorization
//   Header: Transferring Payload in a Single Chunk", example 1.
// - The signing-key derivation example from the IAM SigV4 documentation.

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('get-vanilla from the SigV4 test suite', async () => {
  const signed = await signV4(
    {
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      payloadHash: EMPTY_SHA256,
      region: 'us-east-1',
      service: 'service',
      now: new Date('2015-08-30T12:36:00Z'),
    },
    { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
  );
  assert.equal(
    signed.canonicalRequest,
    ['GET', '/', '', 'host:example.amazonaws.com', 'x-amz-date:20150830T123600Z', '', 'host;x-amz-date', EMPTY_SHA256].join('\n'),
  );
  assert.equal(
    signed.stringToSign,
    ['AWS4-HMAC-SHA256', '20150830T123600Z', '20150830/us-east-1/service/aws4_request', 'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63'].join('\n'),
  );
  assert.equal(signed.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(
    signed.headers['authorization'],
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  );
});

test('S3 GET Object example with range and x-amz-content-sha256', async () => {
  const signed = await signV4(
    {
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { Range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_SHA256 },
      payloadHash: EMPTY_SHA256,
      region: 'us-east-1',
      service: 's3',
      now: new Date('2013-05-24T00:00:00Z'),
    },
    { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  );
  assert.equal(
    signed.canonicalRequest,
    [
      'GET',
      '/test.txt',
      '',
      'host:examplebucket.s3.amazonaws.com',
      'range:bytes=0-9',
      `x-amz-content-sha256:${EMPTY_SHA256}`,
      'x-amz-date:20130524T000000Z',
      '',
      'host;range;x-amz-content-sha256;x-amz-date',
      EMPTY_SHA256,
    ].join('\n'),
  );
  assert.equal(signed.stringToSign.split('\n')[3], '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972');
  assert.equal(signed.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('signing key derivation example', async () => {
  const key = await signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam');
  assert.equal(toHex(key), 'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
});

test('canonical query sorts and encodes, treating + literally', () => {
  assert.equal(canonicalQuery('?prefix=env%3A%2F&list-type=2&max-keys=1000'), 'list-type=2&max-keys=1000&prefix=env%3A%2F');
  assert.equal(canonicalQuery('?prefix=env:/'), 'prefix=env%3A%2F');
  assert.equal(canonicalQuery('?a=1+2'), 'a=1%2B2');
  assert.equal(canonicalQuery(''), '');
});

test('unsigned payload header form used for R2', async () => {
  const signed = await signV4(
    {
      method: 'PUT',
      url: new URL('https://acct.r2.cloudflarestorage.com/tf-state/infra/terraform.tfstate'),
      headers: { 'x-amz-content-sha256': UNSIGNED_PAYLOAD, 'content-type': 'application/json' },
      payloadHash: UNSIGNED_PAYLOAD,
      region: 'auto',
      service: 's3',
      now: new Date('2026-10-15T12:00:00.000Z'),
    },
    { accessKeyId: 'a'.repeat(32), secretAccessKey: 'b'.repeat(64) },
  );
  assert.equal(toAmzDate(new Date('2026-10-15T12:00:00.000Z')), '20261015T120000Z');
  assert.match(signed.headers['authorization'] ?? '', /^AWS4-HMAC-SHA256 Credential=a{32}\/20261015\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(signed.canonicalRequest.split('\n').at(-1), UNSIGNED_PAYLOAD);
});
