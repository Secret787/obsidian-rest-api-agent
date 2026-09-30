<div align="center">

# REST API for Agents

**Secure local REST API for AI agents and automation.**

[![Release](https://img.shields.io/github/v/release/Secret787/obsidian-rest-api-agent?style=flat-square&color=7c3aed)](https://github.com/Secret787/obsidian-rest-api-agent/releases)
[![License](https://img.shields.io/github/license/Secret787/obsidian-rest-api-agent?style=flat-square&color=22c55e)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-%E2%89%A51.0.0-7c3aed?style=flat-square&logo=obsidian&logoColor=white)](https://obsidian.md)
[![Platform](https://img.shields.io/badge/platform-desktop-64748b?style=flat-square)](#платформы)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-22c55e?style=flat-square)](https://github.com/Secret787/obsidian-rest-api-agent/pulls)

Плагин поднимает локальный HTTP-сервер внутри Obsidian и даёт внешним агентам, скриптам и CLI-инструментам доступ к вашему хранилищу — безопасно, по токену, с полным контролем над тем, что разрешено.

[Быстрый старт](docs/QUICKSTART.md) · [API-контракты](docs/API.md) · [Безопасность](SECURITY.md) · [Changelog](CHANGELOG.md)

</div>

---

## Возможности

| Категория | Что доступно |
|---|---|
| **Файлы** | Чтение, запись, append, удаление — текст и бинарники |
| **Папки** | Создание (рекурсивно), листинг, удаление (empty/recursive) |
| **Batch** | Атомарные `read` / `write` / `delete` / `move` одним запросом |
| **Поиск** | Lexical, exact, regex, fuzzy; по пути, содержимому, тегам, frontmatter |
| **Граф** | Backlinks и outlinks по `metadataCache` |
| **Метаданные** | Frontmatter, wikilinks, теги, mtime, ctime, SHA-256, MIME |
| **Бинарники** | `PUT` raw-body или `POST /upload` с base64 |
| **Безопасность** | Bearer-токен, rate limit, read-only режим, сетевые фильтры |
| **Платформа** | Desktop only (использует Node.js `http`, `crypto`, `os`) |

## Быстрый старт

```bash
# 1. Проверить, что сервер жив (без токена)
curl http://127.0.0.1:27125/health
# → {"status":"ok"}

# 2. Прочитать список файлов vault (нужен токен из настроек плагина)
curl -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
     http://127.0.0.1:27125/tree

# 3. Записать заметку
curl -X PUT \
     -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
     -H "Content-Type: text/markdown" \
     --data-binary "Hello from the API" \
     http://127.0.0.1:27125/vault/notes/hello.md
```

Полная инструкция — [docs/QUICKSTART.md](docs/QUICKSTART.md).
Контракты всех эндпоинтов — [docs/API.md](docs/API.md).

## Установка

### Из Community Store

1. Откройте **Obsidian → Settings → Community plugins → Browse**.
2. Найдите **REST API for Agents**.
3. Установите и включите плагин.

### Вручную (BRAT или из релиза)

1. Скачайте `main.js` и `manifest.json` из [последнего релиза](https://github.com/Secret787/obsidian-rest-api-agent/releases/latest).
2. Положите оба файла в `<ваш-vault>/.obsidian/plugins/obsidian-rest-api-agent/`.
3. В Obsidian: **Settings → Community plugins → Reload → Enable**.

## Конфигурация

Все параметры плагина доступны в **Settings → REST API for Agents** и применяются мгновенно.

| Параметр | По умолчанию | Описание |
|---|---|---|
| `Порт` | `27125` | TCP-порт сервера |
| `Токен` | генерируется | Bearer-токен; можно перегенерировать, показать, скопировать |
| `Разрешить доступ из локальной сети` | `off` | Bind на `0.0.0.0` вместо `127.0.0.1` |
| `Сетевые адаптеры` | все разрешены | Можно исключить VPN, Docker, отдельные интерфейсы |
| `Только чтение` | `off` | Блокирует `PUT` / `POST` / `DELETE` / `PATCH` |
| `Максимальный размер файла` | `10 МБ` | Применяется к тексту и бинарникам |
| `Rate limit` | `120 запр./мин` | Лимит запросов на IP |

## Безопасность

- Все запросы, кроме `/health`, требуют заголовок `Authorization: Bearer <token>`.
- По умолчанию сервер слушает только `127.0.0.1` — из локальной сети недоступен.
- Публичный `/health` отдаёт только `{"status":"ok"}` — без метаданных vault.
- Пути `.obsidian*`, `.trash`, `.git`, `.smart-env` блокируются.
- Сравнение токена — `crypto.timingSafeEqual`, защита от timing-атак.
- Rate limit применяется ко всем запросам.

Полная модель угроз и рекомендации — [SECURITY.md](SECURITY.md).

> Если включён доступ из локальной сети, токен — единственная защита. Не выставляйте порт в интернет.

## Ограничения

- `GET /tree?with_hash=1` читает все файлы vault — на больших хранилищах медленно.
- `GET /search?q=…` обходит все файлы; нет таймаута на запрос.
- Audit log отсутствует. Все операции с vault не логируются.
- Мобильные платформы не поддерживаются.

## Документация

| Документ | Что внутри |
|---|---|
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | Первый запрос за 60 секунд, cURL-примеры, хелперы для shell |
| [docs/API.md](docs/API.md) | Полные контракты всех эндпоинтов: методы, тела, коды, ошибки |
| [SECURITY.md](SECURITY.md) | Модель угроз, ограничения, как сообщить об уязвимости |
| [CHANGELOG.md](CHANGELOG.md) | История версий |

## Разработка

```bash
git clone https://github.com/Secret787/obsidian-rest-api-agent.git
cd obsidian-rest-api-agent
node --check main.js           # быстрая проверка синтаксиса
```

Плагин собирается без bundler: `main.js` — это CommonJS-файл, который Obsidian загружает напрямую. Все Node.js модули (`http`, `crypto`, `os`) импортируются через `require`.

### Структура репозитория

```
.
├── main.js                        # точка входа плагина (CommonJS)
├── manifest.json                  # метаданные Obsidian
├── versions.json                  # карта совместимости версий
├── docs/
│   ├── API.md                     # контракты эндпоинтов
│   └── QUICKSTART.md              # быстрый старт
├── .github/workflows/release.yml  # автопубликация при push тега
├── LICENSE
├── README.md
├── SECURITY.md
└── CHANGELOG.md
```

## Contributing

Issues и PR приветствуются. Перед PR:

1. Проверьте синтаксис: `node --check main.js`.
2. Бампните версию в `manifest.json` и `versions.json`.
3. Обновите `CHANGELOG.md`.
4. Опишите изменение в PR.

## Лицензия

[MIT](LICENSE) © Kuznetsov Roman
