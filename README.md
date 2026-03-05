# 🟪 OkakPix v2

Піксель-баттл з pixelplanet-стилем. Один canvas, живі пікселі, бінарний WS протокол.

## Запуск

```bash
npm install
npm start
# → http://localhost:3000
```

## Admin
- Нікнейм: `admin`
- Пароль: `admin`
- Безкінечний стак, 0 кулдауну

## Deploy (Railway / Render)

1. Завантаж папку на GitHub
2. Railway.app → New Project → Deploy from GitHub
3. Start command: `npm start`
4. Готово! Поділись посиланням з друзями.

## Швидкий тест з друзями (ngrok)

```bash
npm start
# Новий термінал:
npx ngrok http 3000
# Скопіюй https://... посилання → дай другу
```

## Структура

```
okakpix/
├── server.js        ← Node.js + WS сервер
├── index.html       ← Клієнт (pixelplanet UI)
├── earth.png        ← Стартова карта 1024×1024
├── package.json
├── users.json       ← Автоматично
└── canvas_state.bin ← Автоматично (зберігається кожні 30с)
```

## Клавіші

| Дія | Клавіша |
|-----|---------|
| Піксель | ЛКМ |
| Олівець | `2` або кнопка ✏️ |
| Пан | ПКМ / Пробіл+ЛКМ |
| Зум | Колесо / +/- |
