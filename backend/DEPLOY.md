# ═══════════════════════════════════════════════════════════════
# PP Exchange Backend - Deployment Guide
# ═══════════════════════════════════════════════════════════════

## 🎯 Что это

Полный бекенд на Node.js, который заменяет все 6 n8n воркфлоу:
- PP Exchange форма (hCaptcha + валидация + Telegram)
- PayPal IPN обработчик
- Income notifications от Apps Script
- Screenshot сервис (по messageId и txnId)
- Sync Google Sheets → Supabase

## 📋 Требования

- Ubuntu 22.04+ VPS (минимум 1GB RAM, 1 CPU)
- Node.js 20+
- Docker & Docker Compose
- Домены: pp.daniilink.com, api.daniilink.com
- Supabase проект
- Google Cloud проект с Gmail API

---

## 🚀 БЫСТРЫЙ ДЕПЛОЙ (копируй и выполняй)

### 1. Подключись к VPS и подготовь систему

```bash
# Обновление системы
sudo apt update && sudo apt upgrade -y

# Установка Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Установка Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Установка nginx и certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# Перелогинься для применения docker группы
exit
```

### 2. Создай структуру проекта

```bash
# Создай директории
sudo mkdir -p /var/www/pp-exchange/{backend,website}
cd /var/www/pp-exchange/backend

# Склонируй код (или скопируй файлы)
# Если у тебя git репо:
# git clone https://github.com/YOUR_REPO/pp-backend.git .

# Или создай файлы вручную (см. секцию FILES ниже)
```

### 3. Настрой переменные окружения

```bash
# Создай .env файл
cat > /var/www/pp-exchange/backend/.env << 'EOF'
# Server
PORT=3000
NODE_ENV=production
BASE_URL=https://api.daniilink.com

# Supabase
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_KEY=YOUR_SERVICE_ROLE_KEY

# Telegram
TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN
TELEGRAM_CHAT_ID=YOUR_CHAT_ID
TELEGRAM_ERROR_CHAT_ID=YOUR_ERROR_CHAT_ID

# hCaptcha
HCAPTCHA_SECRET=YOUR_HCAPTCHA_SECRET

# Gmail API
GMAIL_CLIENT_ID=YOUR_CLIENT_ID
GMAIL_CLIENT_SECRET=YOUR_CLIENT_SECRET
GMAIL_REFRESH_TOKEN_1=REFRESH_TOKEN_FOR_ACCOUNT_1
GMAIL_REFRESH_TOKEN_2=REFRESH_TOKEN_FOR_ACCOUNT_2
GMAIL_REFRESH_TOKEN_3=REFRESH_TOKEN_FOR_ACCOUNT_3

# Screenshot Service
SCREENSHOT_SERVICE_URL=http://screenshot-service:3000/screenshot

# PayPal
PAYPAL_IPN_URL=https://ipnpb.paypal.com/cgi-bin/webscr

# Google Sheets
GOOGLE_SHEET_ID=1ed_jRmVJkq1_EhpY62wtIAI4HQQjdBShtuKxuDxfyl8
EOF

# Замени YOUR_* на реальные значения
nano /var/www/pp-exchange/backend/.env
```

### 4. Запусти контейнеры

```bash
cd /var/www/pp-exchange/backend

# Собери и запусти
docker-compose up -d --build

# Проверь статус
docker-compose ps
docker-compose logs -f pp-backend
```

### 5. Настрой SSL сертификаты

```bash
# Получи сертификаты
sudo certbot --nginx -d pp.daniilink.com -d api.daniilink.com

# Автообновление (уже настроено certbot'ом)
```

### 6. Настрой nginx

```bash
# Скопируй конфиг
sudo cp /var/www/pp-exchange/backend/nginx/pp-exchange.conf /etc/nginx/sites-available/

# Включи сайт
sudo ln -s /etc/nginx/sites-available/pp-exchange.conf /etc/nginx/sites-enabled/

# Проверь конфиг
sudo nginx -t

# Перезапусти nginx
sudo systemctl reload nginx
```

### 7. Скопируй сайт

```bash
# Скопируй index.html в папку сайта
cp /var/www/pp-exchange/backend/website/index.html /var/www/pp-exchange/website/
```

### 8. Настрой Supabase

```bash
# Применить миграцию через Supabase Dashboard или CLI:
# 1. Зайди в Supabase Dashboard → SQL Editor
# 2. Скопируй содержимое supabase/migrations/001_initial_schema.sql
# 3. Выполни
```

---

## 🔧 НАСТРОЙКА GMAIL API

### Шаг 1: Создай OAuth credentials

1. Зайди на https://console.cloud.google.com
2. Создай проект (или выбери существующий)
3. Включи Gmail API: APIs & Services → Enable APIs → Gmail API
4. Создай OAuth consent screen (External, добавь email в Test users)
5. Создай credentials: APIs & Services → Credentials → Create → OAuth client ID
   - Application type: Web application
   - Authorized redirect URIs: `https://developers.google.com/oauthplayground`
6. Скопируй Client ID и Client Secret

### Шаг 2: Получи Refresh Token

1. Зайди на https://developers.google.com/oauthplayground
2. Нажми шестерёнку справа вверху
3. Включи "Use your own OAuth credentials"
4. Введи Client ID и Client Secret
5. В левой панели найди Gmail API v1
6. Выбери: `https://www.googleapis.com/auth/gmail.readonly`
7. Нажми "Authorize APIs"
8. Залогинься нужным Gmail аккаунтом
9. Нажми "Exchange authorization code for tokens"
10. Скопируй Refresh Token

**Повтори для каждого Gmail аккаунта!**

---

## 📝 ОБНОВЛЕНИЕ APPS SCRIPT

Замени URL вебхуков в твоих Google Apps Script:

```javascript
// Было:
const webhookUrl = "https://n8n.daniilink.com/webhook/incomes";
const webhookUrl = "https://n8n.daniilink.com/webhook/UpdateClients";
const webhookUrl = "https://n8n.daniilink.com/webhook/paypals-to-db";

// Стало:
const webhookUrl = "https://api.daniilink.com/webhook/incomes";
const webhookUrl = "https://api.daniilink.com/webhook/UpdateClients";
const webhookUrl = "https://api.daniilink.com/webhook/paypals-to-db";
```

---

## 🔍 ПРОВЕРКА РАБОТЫ

```bash
# Health check
curl https://api.daniilink.com/health

# Должен вернуть:
# {"status":"ok","timestamp":"2026-02-20T..."}

# Проверить логи
cd /var/www/pp-exchange/backend
docker-compose logs -f pp-backend

# Проверить screenshot service
docker-compose logs -f screenshot-service
```

---

## 🛠 ПОЛЕЗНЫЕ КОМАНДЫ

```bash
# Перезапуск
docker-compose restart

# Остановка
docker-compose down

# Обновление после изменений
docker-compose up -d --build

# Просмотр логов
docker-compose logs -f

# Проверка использования ресурсов
docker stats
```

---

## 💰 ЭКОНОМИЯ

**Было (n8n):**
- VPS: 2GB RAM минимум = ~$12-20/мес
- n8n потребляет 1-2GB RAM постоянно

**Стало (Node.js):**
- VPS: 1GB RAM достаточно = ~$5-10/мес
- Backend потребляет ~50-100MB RAM
- Screenshot service: ~200-300MB при работе

**Экономия: ~50-60% на хостинге**

---

## ❓ TROUBLESHOOTING

### Контейнер не запускается
```bash
docker-compose logs pp-backend
# Проверь .env файл на ошибки
```

### Gmail API ошибки
```bash
# Проверь refresh token - он мог истечь
# Переполучи через OAuth Playground
```

### Screenshot не работает
```bash
docker-compose logs screenshot-service
# Проверь что puppeteer-server запущен
```

### Telegram не отправляет
```bash
# Проверь BOT_TOKEN и CHAT_ID
curl "https://api.telegram.org/bot<TOKEN>/getMe"
```
