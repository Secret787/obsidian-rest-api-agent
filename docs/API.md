# API Contracts

База: `http://127.0.0.1:27125` (по умолчанию). Порт настраивается в плагине.

## Соглашения

| Тема | Правило |
|---|---|
| Формат | `application/json; charset=utf-8` для JSON, MIME по расширению для файлов |
| Аутентификация | `Authorization: Bearer <token>` — все эндпоинты, кроме `GET /health` |
| Кодировка пути | `encodeURIComponent` для сегментов; слеши внутри пути не кодируются |
| Длина тела | до 32 МБ (`MAX_BODY`), сверх — `413` |
| Размер файла | до `maxFileSize` (по умолчанию 10 МБ), сверх — `413` |
| Идемпотентность | `GET` / `PUT` / `DELETE` — идемпотентны, `POST` — нет |
| Время | ISO 8601 UTC (`2026-01-15T10:30:00.000Z`) |
| Хеш | `sha256:<hex>`, нижний регистр |

## Формат ошибок

Все ошибки имеют одинаковую форму:

```json
{
  "error": "not_found",
  "message": "File not found: notes/hello.md",
  "status": 404,
  "details": { "path": "notes/hello.md" }
}
```

`details` — опционально.

## Коды ошибок

| HTTP | `error` | Когда |
|---|---|---|
| `400` | `invalid_request` | Плохой JSON, невалидный путь, отсутствует параметр, invalid base64 / regex |
| `401` | `unauthorized` | Токен отсутствует или неверен |
| `403` | `forbidden` | Read-only режим, запрос с запрещённого интерфейса |
| `404` | `not_found` | Файл, папка или эндпоинт не найдены |
| `405` | `method_not_allowed` | Метод не поддерживается для эндпоинта |
| `409` | `conflict` | Папка не пуста, целевой файл существует, rollback atomic batch |
| `413` | `payload_too_large` | Тело или файл больше лимита |
| `429` | `too_many_requests` | Превышен rate limit |
| `500` | `internal_error` | Внутренняя ошибка |

---

## Служебные эндпоинты

### `GET /health`

Публичный. Токен не требуется. Используется для liveness-проверки.

**Ответ `200`:**

```json
{ "status": "ok" }
```

### `GET /capabilities`

Что умеет плагин. Полезно для агентов, которые адаптируются под сервер.

**Ответ `200`:**

```json
{
  "batch_read": true,
  "batch_write": true,
  "batch_delete": true,
  "move": true,
  "rmdir": true,
  "tree": true,
  "meta": true,
  "backlinks": true,
  "outlinks": true,
  "search": { "mode": ["lexical", "regex", "exact", "fuzzy"], "snippet": true },
  "atomic_batch": true,
  "events": false,
  "read_only_mode": false,
  "binary": true,
  "upload": { "json_base64": "/upload", "raw_put": "/vault/{path}" }
}
```

---

## Файлы

### `GET /vault/{path}`

Прочитать файл.

- Текстовые расширения (`md`, `txt`, `json`, `yaml`, `js`, `py`, …) → `text/*` или `application/json`.
- Бинарные (`png`, `pdf`, `mp3`, `zip`, …) → соответствующий MIME, тело — raw bytes.
- Если `{path}` заканчивается на `/` или пуст → листинг папки (см. `GET /vault/{folder}/`).

**Ответ `200`:** содержимое файла.

**Ошибки:** `404` — файла нет; `413` — файл больше `maxFileSize`.

### `PUT /vault/{path}`

Записать файл. Перезаписывает существующий.

**Тело:** raw bytes.

**Content-Type:**
- Для текстовых путей — любой (`text/*`, `application/json` и т.п.).
- Для бинарных — рекомендуется точный MIME (`image/png`, `application/pdf`).

**Ответ `200` (текст):**

```json
{ "ok": true }
```

**Ответ `200` (бинарник):**

```json
{ "ok": true, "size": 20480, "mime": "image/png" }
```

**Ошибки:** `400` — путь ведёт в директорию; `413` — тело больше `maxFileSize`.

### `POST /vault/{path}`

Дописать в конец файла. Только для текстовых расширений. Между старым и новым содержимым вставляется `\n\n`.

**Ответ `200`:** `{"ok": true}`

**Ошибки:** `400` — бинарный путь; `413` — превышение `maxFileSize`.

### `DELETE /vault/{path}`

Удалить файл.

**Ответ `204`:** пустое тело.

**Ошибки:** `404` — файла нет.

### `GET /vault/{folder}/`

Листинг папки (path заканчивается на `/`).

**Ответ `200`:**

```json
{
  "files": ["note.md", "image.png", "subfolder/"]
}
```

Подпапки помечаются trailing-слэшем.

---

## Папки

### `POST /mkdir`

Создать папку рекурсивно (аналог `mkdir -p`).

**Тело:**

```json
{ "path": "projects/2026/q1" }
```

**Ответ `200`:** `{"ok": true}`

### `DELETE /folder/{path}?recursive=1`

Удалить папку.

**Query:**
- `recursive=1` — удалить вместе с содержимым.
- `empty_only=1` — удалить только если папка пуста (иначе `200`, но `skipped: [path]`).

Без параметров, если папка не пуста → `409`.

**Ответ `200`:**

```json
{
  "deleted": ["old-stuff/a.md", "old-stuff/b.md", "old-stuff"],
  "skipped": []
}
```

### `POST /rmdir`

Batch-удаление пустых папок.

**Тело:**

```json
{ "paths": ["empty1", "empty2", "not-empty"] }
```

**Ответ `200`:**

```json
{
  "deleted": ["empty1", "empty2"],
  "not_empty": ["not-empty"]
}
```

---

## Batch-операции

Все batch-эндпоинты принимают JSON и возвращают JSON. Поле `atomic: true` включает режим отката: при любой ошибке все изменения отменяются, оригиналы восстанавливаются.

### `POST /batch/read`

**Тело:**

```json
{ "paths": ["notes/a.md", "notes/b.md", "missing.md"] }
```

**Ответ `200`:**

```json
{
  "files": {
    "notes/a.md": "# A",
    "notes/b.md": "# B",
    "missing.md": null
  }
}
```

Ключи — ровно те строки, что пришли в запросе. Отсутствующие файлы → `null`.

### `POST /batch/write`

Только текстовые пути.

**Тело:**

```json
{
  "atomic": true,
  "files": [
    { "path": "notes/a.md", "content": "# A", "mode": "overwrite" },
    { "path": "notes/b.md", "content": "append", "mode": "append" }
  ]
}
```

`mode`: `overwrite` (по умолчанию) или `append`.

**Ответ `200`:**

```json
{
  "results": [
    { "path": "notes/a.md", "ok": true },
    { "path": "notes/b.md", "ok": true }
  ],
  "atomic": true
}
```

**Ошибки:**
- `400` — бинарный путь в списке.
- `409` — ошибка в atomic-режиме, всё откатилось. Ответ: `{"error":"conflict","message":"Atomic batch failed; rolled back","details":{"rolled_back":N}}`.

### `POST /batch/delete`

**Тело:**

```json
{ "paths": ["notes/a.md", "missing.md"] }
```

**Ответ `200`:**

```json
{
  "deleted": ["notes/a.md"],
  "not_found": ["missing.md"]
}
```

### `POST /batch/move`

Перемещение = read → write → delete. Только текстовые пути.

**Тело:**

```json
{
  "moves": [
    { "from": "inbox/a.md", "to": "notes/a.md" },
    { "from": "x.md",       "to": "y.md" }
  ]
}
```

**Ответ `200`:**

```json
{
  "results": [
    { "from": "inbox/a.md", "to": "notes/a.md", "ok": true },
    { "from": "x.md",       "to": "y.md",       "ok": false, "error": "conflict" }
  ]
}
```

Возможные `error`: `invalid_path`, `not_found`, `conflict`, `binary_not_supported`, `internal`.

---

## Поиск

### `GET /search`

**Query:**

| Параметр | Тип | По умолчанию | Описание |
|---|---|---|---|
| `q` | string | — | Обязателен. Строка или regex. |
| `mode` | `lexical` / `exact` / `regex` / `fuzzy` | `lexical` | Режим сравнения |
| `exact` | `1` | — | Синоним `mode=exact` |
| `limit` | int (1–1000) | `50` | Максимум результатов |
| `in_path` | `1` | — | Искать в пути |
| `in_content` | `1` | включено, если нет `in_path` | Искать в содержимом |
| `frontmatter` | `key:value` | — | Фильтр по frontmatter |

**Ответ `200`:**

```json
{
  "hits": [
    {
      "path": "notes/hello.md",
      "score": 1.5,
      "snippet": "…текст вокруг совпадения…"
    }
  ]
}
```

Скоринг: `in_path` → +1, `in_content` → +0.5. Сортировка по убыванию score.

### `POST /search_by_tags`

**Тело:**

```json
{ "tags": ["project", "wip"], "op": "and", "limit": 100 }
```

`op`: `and` (по умолчанию) или `or`. Теги ищутся и во frontmatter, и inline (`#tag`). Символ `#` опционален.

**Ответ `200`:**

```json
{ "paths": ["projects/alpha.md", "projects/beta.md"] }
```

---

## Граф ссылок

### `GET /backlinks/{path}`

Кто ссылается на файл.

**Ответ `200`:**

```json
{ "backlinks": ["journal/2026-01-15.md"], "count": 1 }
```

### `GET /outlinks/{path}`

Ссылки из файла.

**Ответ `200`:**

```json
{
  "outlinks": [
    { "target": "notes/hello.md",  "resolved": true },
    { "target": "not-yet-created", "resolved": false }
  ]
}
```

---

## Метаданные

### `GET /meta/{path}`

**Ответ `200`:**

```json
{
  "path": "notes/hello.md",
  "size": 1024,
  "mtime": "2026-01-15T10:30:00.000Z",
  "ctime": "2026-01-10T08:00:00.000Z",
  "hash": "sha256:ab12…",
  "mime": "text/markdown; charset=utf-8",
  "binary": false,
  "frontmatter": { "tags": ["project"], "status": "wip" },
  "wikilinks": ["other-note", "projects/roadmap"],
  "tags": ["project", "wip"]
}
```

`wikilinks` — из `metadataCache.links`, `tags` — из `metadataCache.tags` без `#`.

---

## Дерево

### `GET /tree`

**Query:**

| Параметр | Описание |
|---|---|
| `with_hash=1` | Добавить `sha256` каждого файла (медленно на больших vault) |
| `with_mtime=1` | Добавить ISO mtime |
| `with_size=1` | Добавить размер в байтах |
| `dirs_only=1` | Только папки |
| `files_only=1` | Только файлы |

**Ответ `200`:**

```json
{
  "files": ["notes/hello.md", "projects/roadmap.md"],
  "dirs": ["notes", "projects"],
  "meta": {
    "notes/hello.md": {
      "size": 1024,
      "mtime": "2026-01-15T10:30:00.000Z",
      "hash": "sha256:ab12…"
    }
  }
}
```

`meta` заполняется только если запрошен хотя бы один из `with_*`.

---

## Загрузка бинарников

### `POST /upload`

**Тело:**

```json
{
  "path": "attachments/screenshot.png",
  "content_base64": "iVBORw0KGgo…"
}
```

Принимается также data-URL (`data:image/png;base64,…`).

**Ответ `200`:**

```json
{
  "ok": true,
  "path": "attachments/screenshot.png",
  "size": 20480,
  "mime": "image/png"
}
```

**Ошибки:** `400` — invalid base64 / пустой контент; `413` — больше `maxFileSize`.

### `PUT /vault/{path}` (альтернатива)

Raw body + корректный `Content-Type` — то же самое, что `POST /upload`, но без base64-overhead.

---

## Ограничения

- `GET /tree?with_hash=1` читает **все** файлы vault в память по одному. На больших хранилищах это минуты. Таймаута на сервере нет.
- `GET /search` без `limit` обходит все файлы. Рекомендуется ставить `limit` ≤ 100.
- `metadataCache` заполняется Obsidian асинхронно. Сразу после старта vault `backlinks`, `outlinks`, `tags` могут быть неполными.
- Ответы не кешируются (`Cache-Control: no-store`).
- Заголовки безопасности: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
