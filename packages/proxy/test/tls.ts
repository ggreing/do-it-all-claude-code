// Test-only TLS material, made at run time (nothing is stored in the repository): a self-signed EC certificate
// for the given DNS names and IPv4 addresses, written as DER by hand because Node has no API that creates one.
import crypto from 'node:crypto';

const len = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const b: number[] = [];
  for (let x = n; x; x >>= 8) b.unshift(x & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
};
const tlv = (tag: number, ...parts: Buffer[]): Buffer => { const c = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(c.length), c]); };
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const oid = (s: string): Buffer => {
  const a = s.split('.').map(Number);
  const out = [40 * a[0]! + a[1]!];
  for (const v of a.slice(2)) {
    const b = [v & 0x7f];
    for (let x = v >> 7; x; x >>= 7) b.unshift(0x80 | (x & 0x7f));
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
};
const utcTime = (d: Date) => tlv(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));
const name = (cn: string) => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));

/**
 * A DER INTEGER for an unsigned big-endian number, in the minimal two's-complement form DER requires: leading 0x00
 * bytes dropped (OpenSSL 3 refuses them as "illegal padding"), and one 0x00 put back when the high bit is set (it
 * would read as negative otherwise).
 */
export function derUnsignedInteger(bytes: Buffer): Buffer {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  let b = bytes.length ? bytes.subarray(i) : Buffer.from([0]);
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

export interface TestCert { cert: string; key: string }

/** A self-signed certificate (also its own CA) valid for a day, for `dns` names and `ips` (IPv4). */
export function selfSignedCert(cn: string, dns: string[], ips: string[] = [], opts: { serial?: Buffer } = {}): TestCert {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const serial = Buffer.from(opts.serial ?? crypto.randomBytes(8));
  if (serial.every(x => x === 0)) serial[serial.length - 1] = 1;   // a certificate serial is a positive number
  const alg = seq(oid('1.2.840.10045.4.3.2'));   // ecdsa-with-SHA256
  const now = Date.now();
  const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
  const san = seq(...dns.map(d => tlv(0x82, Buffer.from(d))), ...ips.map(ip => tlv(0x87, Buffer.from(ip.split('.').map(Number)))));
  const tbs = seq(
    tlv(0xa0, derUnsignedInteger(Buffer.from([2]))), derUnsignedInteger(serial), alg, name(cn),
    seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 86_400_000))), name(cn),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(ext('2.5.29.19', true, seq(tlv(0x01, Buffer.from([0xff])))), ext('2.5.29.17', false, san))),
  );
  const der = seq(tbs, alg, tlv(0x03, Buffer.from([0]), crypto.sign('sha256', tbs, privateKey)));
  const b64 = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  return { cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}
