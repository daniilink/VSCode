# Восстановление бэкапа базы данных

## Шаг 1: Скачай файл
Скачай `.db.enc` файл из Telegram (бот отправляет раз в неделю).

## Шаг 2: Расшифруй
Создай файл `restore.js`:

```javascript
import crypto from 'crypto';
import fs from 'fs';

// ═══════════════════════════════════════════════════
// НАСТРОЙКИ - ИЗМЕНИ ЭТИ ЗНАЧЕНИЯ
// ═══════════════════════════════════════════════════
const BACKUP_FILE = 'pp-exchange-2026-02-22_05-30-00.db.enc';  // имя скачанного файла
const PASSWORD = 'YOUR_ADMIN_KEY_HERE';  // твой ADMIN_KEY из .env
const OUTPUT_FILE = 'pp-exchange-restored.db';
// ═══════════════════════════════════════════════════

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

// Расшифровка
const encrypted = fs.readFileSync(BACKUP_FILE);
const decrypted = decrypt(encrypted, PASSWORD);
fs.writeFileSync(OUTPUT_FILE, decrypted);

console.log(`✅ База данных восстановлена: ${OUTPUT_FILE}`);
console.log(`📦 Размер: ${(decrypted.length / 1024).toFixed(1)} KB`);
```

## Шаг 3: Запусти
```bash
node restore.js
```

## Шаг 4: Используй
Теперь можешь открыть `pp-exchange-restored.db` любым SQLite клиентом:
- DB Browser for SQLite (GUI)
- `sqlite3 pp-exchange-restored.db` (CLI)

Или скопируй обратно на сервер:
```bash
scp pp-exchange-restored.db root@your-server:/var/lib/docker/volumes/backend_pp-data/_data/pp-exchange.db
docker restart pp-backend
```

---

## Безопасность
- Бэкап зашифрован AES-256-GCM (военный стандарт)
- Пароль = твой ADMIN_KEY
- Без пароля файл бесполезен
