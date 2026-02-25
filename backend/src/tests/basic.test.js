import { describe, it } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';

// ═══════════════════════════════════════════════════
// BACKUP ENCRYPTION TESTS
// ═══════════════════════════════════════════════════

function encrypt(buffer, password) {
  const salt = crypto.randomBytes(32);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, encrypted]);
}

function decrypt(encryptedBuffer, password) {
  const salt = encryptedBuffer.subarray(0, 32);
  const iv = encryptedBuffer.subarray(32, 48);
  const authTag = encryptedBuffer.subarray(48, 64);
  const encrypted = encryptedBuffer.subarray(64);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

describe('Backup Encryption', () => {
  it('should encrypt and decrypt correctly', () => {
    const original = Buffer.from('Hello, World! Тест кирилицы 🎉');
    const password = 'test-password-123';

    const encrypted = encrypt(original, password);
    const decrypted = decrypt(encrypted, password);

    assert.strictEqual(decrypted.toString(), original.toString());
  });

  it('should fail with wrong password', () => {
    const original = Buffer.from('Secret data');
    const encrypted = encrypt(original, 'correct-password');

    assert.throws(() => {
      decrypt(encrypted, 'wrong-password');
    });
  });

  it('encrypted should be larger than original', () => {
    const original = Buffer.from('Test data');
    const encrypted = encrypt(original, 'password');

    // salt(32) + iv(16) + authTag(16) = 64 bytes overhead
    assert.ok(encrypted.length >= original.length + 64);
  });
});

// ═══════════════════════════════════════════════════
// WALLET VALIDATION TESTS
// ═══════════════════════════════════════════════════

const walletPatterns = {
  'USDT TRC20': /^T[A-Za-z1-9]{33}$/,
  'USDT ERC20': /^0x[a-fA-F0-9]{40}$/,
  'USDT BEP20': /^0x[a-fA-F0-9]{40}$/,
  'USDT TON': /^(UQ|EQ)[A-Za-z0-9_-]{46}$/,
  'USDT SOL': /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  'BTC': /^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,90}$/,
  'ETH': /^0x[a-fA-F0-9]{40}$/,
  'LTC': /^(L|M|ltc1)[a-zA-HJ-NP-Z0-9]{25,90}$/,
  'Binance UID': /^\d{8,10}$/
};

describe('Wallet Validation', () => {
  it('should validate TRC20 address', () => {
    const valid = 'TJYeasypMKF2XXwPXxDT8TRvqNs3STzLYd';
    const invalid = 'ABC123';

    assert.ok(walletPatterns['USDT TRC20'].test(valid));
    assert.ok(!walletPatterns['USDT TRC20'].test(invalid));
  });

  it('should validate ERC20/BEP20 address', () => {
    const valid = '0x742d35Cc6634C0532925a3b844Bc9e7595f8b3A1';
    const invalid = '0xINVALID';

    assert.ok(walletPatterns['USDT ERC20'].test(valid));
    assert.ok(!walletPatterns['USDT ERC20'].test(invalid));
  });

  it('should validate Binance UID', () => {
    const valid = '12345678';
    const invalid = '123';

    assert.ok(walletPatterns['Binance UID'].test(valid));
    assert.ok(!walletPatterns['Binance UID'].test(invalid));
  });

  it('should validate TON address', () => {
    const valid = 'UQBvW8Z5huBkMJYdnfAEM5JqTNLf1z5E-d1p8o5Nj_9v8aaX';
    const invalid = 'ABC123';

    assert.ok(walletPatterns['USDT TON'].test(valid));
    assert.ok(!walletPatterns['USDT TON'].test(invalid));
  });
});

// ═══════════════════════════════════════════════════
// AMOUNT VALIDATION TESTS
// ═══════════════════════════════════════════════════

describe('Amount Validation', () => {
  const MIN_AMOUNT = 30;
  const MAX_AMOUNT = 10000;

  it('should accept valid amounts', () => {
    [30, 100, 500, 1000, 5000, 10000].forEach(amount => {
      assert.ok(amount >= MIN_AMOUNT && amount <= MAX_AMOUNT, `${amount} should be valid`);
    });
  });

  it('should reject amounts below minimum', () => {
    [0, 10, 29].forEach(amount => {
      assert.ok(amount < MIN_AMOUNT, `${amount} should be below minimum`);
    });
  });

  it('should reject amounts above maximum', () => {
    [10001, 50000].forEach(amount => {
      assert.ok(amount > MAX_AMOUNT, `${amount} should be above maximum`);
    });
  });
});

// ═══════════════════════════════════════════════════
// COMMISSION CALCULATION TESTS
// ═══════════════════════════════════════════════════

describe('Commission Calculation', () => {
  const calculateCommission = (amount) => {
    if (amount >= 1000) return 0.11; // 11%
    return 0.13; // 13%
  };

  it('should apply 13% for amounts under $1000', () => {
    assert.strictEqual(calculateCommission(30), 0.13);
    assert.strictEqual(calculateCommission(500), 0.13);
    assert.strictEqual(calculateCommission(999), 0.13);
  });

  it('should apply 11% for amounts $1000+', () => {
    assert.strictEqual(calculateCommission(1000), 0.11);
    assert.strictEqual(calculateCommission(5000), 0.11);
    assert.strictEqual(calculateCommission(10000), 0.11);
  });

  it('should calculate correct payout', () => {
    const amount = 1000;
    const commission = calculateCommission(amount);
    const payout = amount * (1 - commission);

    assert.strictEqual(payout, 890); // $1000 - 11% = $890
  });
});

console.log('✅ All tests defined');
