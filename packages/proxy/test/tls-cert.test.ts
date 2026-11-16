// The test-only certificate writer (tls.ts) must give DER that OpenSSL parses every time: a serial with a leading zero
// byte once failed CI at random ("illegal padding"), about one certificate in 256.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { X509Certificate } from 'node:crypto';
import { derUnsignedInteger, selfSignedCert } from './tls.ts';

const hex = (b: Buffer) => b.toString('hex');

test('a DER INTEGER is minimal two\'s complement: no needless leading zero, one added when the high bit is set', () => {
  assert.equal(hex(derUnsignedInteger(Buffer.from([0x00, 0x05]))), '020105');
  assert.equal(hex(derUnsignedInteger(Buffer.from([0x00, 0x00, 0x7f, 0x01]))), '02027f01');
  assert.equal(hex(derUnsignedInteger(Buffer.from([0x80]))), '02020080');
  assert.equal(hex(derUnsignedInteger(Buffer.from([0x00, 0x80]))), '02020080');
  assert.equal(hex(derUnsignedInteger(Buffer.from([0x00, 0x00]))), '020100');
  assert.equal(hex(derUnsignedInteger(Buffer.from([0x12, 0x34]))), '02021234');
});

test('certificates with serials that start with zero bytes or a high bit parse', () => {
  for (const s of [[0x00, 0x01, 0x02], [0x00, 0x00, 0x7f], [0x00, 0x80, 0x01], [0xff, 0xff], [0x00], [0x00, 0x00, 0x00]]) {
    const c = new X509Certificate(selfSignedCert('test', ['localhost'], ['127.0.0.1'], { serial: Buffer.from(s) }).cert);
    assert.equal(c.subject, 'CN=test', hex(Buffer.from(s)));
  }
});

test('200 certificates with random serials all parse, and carry their names', () => {
  for (let i = 0; i < 200; i++) {
    const { cert, key } = selfSignedCert('test', ['localhost'], ['127.0.0.1'], { serial: crypto.randomBytes(1 + (i % 16)) });
    const c = new X509Certificate(cert);
    assert.match(c.subjectAltName ?? '', /DNS:localhost/);
    assert.ok(c.checkPrivateKey(crypto.createPrivateKey(key)));
  }
});
