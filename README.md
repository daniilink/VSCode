# PP Exchange

PayPal → USDT/Binance Pay обменник. Node.js бэкенд + Puppeteer screenshot сервис в Docker.

**Домены:** `pp.daniilink.com` (сайт) · `api.daniilink.com` (API)

---

## Структура репо

```
backend/        — Node.js API + Docker Compose + nginx конфиг
website/        — Статический сайт (HTML/CSS/JS)
```

---

## Деплой на новый VPS (с нуля)

### 1. Подготовка системы

```bash
apt update && apt upgrade -y
apt install -y nginx certbot python3-certbot-nginx

# Docker
curl -fsSL https://get.docker.com | sh
```

### 2. Клонировать репо

```bash
git clone git@github.com:daniilink/VSCode.git /var/www/pp-exchange
cd /var/www/pp-exchange/backend
```

### 3. Создать `.env`

```bash
cp .env.example .env
nano .env        # заполнить все значения
chmod 600 .env
```

Нужные переменные — все расписаны в `.env.example`.

### 4. Запустить контейнеры

```bash
cd /var/www/pp-exchange/backend
docker compose up -d --build

# Проверить
docker compose ps
docker compose logs -f pp-backend
```

### 5. Nginx

```bash
cp /var/www/pp-exchange/backend/nginx/pp-exchange.conf /etc/nginx/sites-available/pp-exchange.conf
ln -s /etc/nginx/sites-available/pp-exchange.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### 6. SSL

```bash
certbot --nginx -d pp.daniilink.com -d api.daniilink.com
```

### 7. Supabase

Зайти в Supabase Dashboard → SQL Editor, выполнить:
```
backend/supabase/migrations/001_initial_schema.sql
```

### 8. Проверить

```bash
curl https://api.daniilink.com/health
# → {"status":"ok","timestamp":"..."}
```

---

## Обновление кода

```bash
cd /var/www/pp-exchange
git pull
cd backend
docker compose up -d --build
```

## Полезные команды

```bash
cd /var/www/pp-exchange/backend

docker compose logs -f pp-backend          # логи бэкенда
docker compose logs -f screenshot-service  # логи puppeteer
docker compose restart                     # перезапуск
docker compose down && docker compose up -d --build  # полный ребилд
docker stats                               # использование ресурсов
```

---

## Восстановление базы из бэкапа

Подробная инструкция: [`backend/BACKUP_RESTORE.md`](backend/BACKUP_RESTORE.md)

Бэкап приходит в Telegram раз в неделю (`.db.enc` файл).

---

## Архитектура

```
Cloudflare
    │
    ▼
Nginx (SSL, rate limiting, статика)
    │
    ├── pp.daniilink.com  →  /var/www/pp-exchange/website/
    │
    └── api.daniilink.com  →  pp-backend:3000
                                    │
                                    ├── screenshot-service (Puppeteer)
                                    └── Supabase (PostgreSQL cloud)
```

## Внешние сервисы

| Сервис | Для чего |
|--------|----------|
| Supabase | БД (clients, paypals, transactions) |
| Telegram Bot | Уведомления + admin dashboard (/admin) |
| hCaptcha | Защита формы обмена |
| Gmail API | Чтение входящих писем |
| Google Sheets | Синхронизация клиентов и PayPal аккаунтов |
| PayPal IPN | Вебхук о входящих платежах |
| Cloudflare | Проксирование, Worker для IPN |
