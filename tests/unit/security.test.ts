import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  hashPassword,
  signToken,
  totpCode,
  verifyPassword,
  verifyToken,
  verifyTotp,
  webhookSignature,
  recoveryCodes,
} from '../../server/src/lib/crypto.js';

describe('crypto', () => {
  it('hashes and verifies passwords with scrypt', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
    expect(await verifyPassword('correct horse battery staple', 'garbage')).toBe(false);
  });

  it('signs and verifies JWTs and rejects tampering', () => {
    const token = signToken({ sub: 'user-1', tid: 'tenant-1', typ: 'access' }, 60);
    expect(verifyToken(token)?.sub).toBe('user-1');
    const [h, b] = token.split('.');
    const forged = `${h}.${b}.deadbeef`;
    expect(verifyToken(forged)).toBeNull();
    expect(verifyToken(signToken({ sub: 'x', typ: 'access' }, -10))).toBeNull();
  });

  it('encrypts secrets with AES-256-GCM and detects tampering', () => {
    const cipher = encryptSecret('super-secret');
    expect(cipher).not.toContain('super-secret');
    expect(decryptSecret(cipher)).toBe('super-secret');
    const tampered = cipher.slice(0, -4) + 'AAAA';
    expect(decryptSecret(tampered)).toBeNull();
  });

  it('generates and verifies TOTP codes', () => {
    const secret = generateTotpSecret();
    const code = totpCode(secret);
    expect(verifyTotp(secret, code)).toBe(true);
    expect(verifyTotp(secret, '000000')).toBe(false);
    expect(verifyTotp(secret, 'abc')).toBe(false);
  });

  it('produces unique recovery codes', () => {
    const codes = recoveryCodes(8);
    expect(new Set(codes).size).toBe(8);
  });

  it('computes deterministic webhook signatures', () => {
    const a = webhookSignature('whsec', '1700000000', '{"a":1}');
    const b = webhookSignature('whsec', '1700000000', '{"a":1}');
    const c = webhookSignature('whsec', '1700000001', '{"a":1}');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
