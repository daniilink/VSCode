import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BACKUP_CHAT_ID = process.env.TELEGRAM_ERROR_CHAT_ID; // Use error chat for backups
const BACKUP_PASSWORD = process.env.BACKUP_PASSWORD || process.env.ADMIN_KEY;
const DB_PATH = '/app/data/pp-exchange.db';

/**
 * Encrypt data with AES-256-GCM
 */
function encrypt(buffer, password) {
  const salt = crypto.randomBytes(32);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const iv = crypto.randomBytes(16);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: salt(32) + iv(16) + authTag(16) + encrypted
  return Buffer.concat([salt, iv, authTag, encrypted]);
}

/**
 * Decrypt data with AES-256-GCM
 */
export function decrypt(encryptedBuffer, password) {
  const salt = encryptedBuffer.subarray(0, 32);
  const iv = encryptedBuffer.subarray(32, 48);
  const authTag = encryptedBuffer.subarray(48, 64);
  const encrypted = encryptedBuffer.subarray(64);

  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * Get Kyiv timestamp for filename
 */
function getKyivTimestamp() {
  const now = new Date();
  const kyiv = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  const pad = n => String(n).padStart(2, '0');
  return `${kyiv.getFullYear()}-${pad(kyiv.getMonth() + 1)}-${pad(kyiv.getDate())}_${pad(kyiv.getHours())}-${pad(kyiv.getMinutes())}-${pad(kyiv.getSeconds())}`;
}

/**
 * Send encrypted backup to Telegram (silent, no notification)
 */
export async function sendBackupToTelegram() {
  try {
    // Read database
    const dbBuffer = fs.readFileSync(DB_PATH);
    const originalSize = dbBuffer.length;

    // Encrypt
    const encrypted = encrypt(dbBuffer, BACKUP_PASSWORD);

    // Kyiv timestamp for filename
    const timestamp = getKyivTimestamp();
    const filename = `pp-exchange-${timestamp}.db.enc`;

    // Send to Telegram (silent)
    const formData = new FormData();
    formData.append('chat_id', BACKUP_CHAT_ID);
    formData.append('caption', `🔒 DB Backup\n📅 ${timestamp.replace('_', ' ')}\n📦 ${(originalSize / 1024).toFixed(1)}KB → ${(encrypted.length / 1024).toFixed(1)}KB`);
    formData.append('document', new Blob([encrypted]), filename);
    formData.append('disable_notification', 'true');

    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      body: formData
    });

    const result = await response.json();

    if (!result.ok) {
      throw new Error(result.description);
    }

    console.log('Backup sent successfully:', filename);
    return { success: true, size: encrypted.length };

  } catch (error) {
    console.error('Backup failed:', error);
    throw error;
  }
}

/**
 * Schedule weekly backup (Sunday 3:00 AM Kyiv time)
 */
export function scheduleBackup() {
  const runBackup = async () => {
    const now = new Date();
    const kyivTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
    const day = kyivTime.getDay(); // 0 = Sunday
    const hour = kyivTime.getHours();

    // Sunday at 3:00 AM
    if (day === 0 && hour === 3) {
      try {
        await sendBackupToTelegram();
      } catch (e) {
        console.error('Scheduled backup failed:', e);
      }
    }
  };

  // Check every hour
  setInterval(runBackup, 60 * 60 * 1000);
  console.log('Backup scheduler started (weekly: Sunday 3:00 AM Kyiv)');
}
