# Быстрый старт

За 60 секунд от установки до первого запроса к vault.

## 1. Установка

**Из Community Store:** Obsidian → Settings → Community plugins → Browse → найти *REST API for Agents* → Install → Enable.

**Вручную:** скачать `main.js` и `manifest.json` из [релиза](https://github.com/Secret787/obsidian-rest-api-agent/releases/latest), положить в `<vault>/.obsidian/plugins/obsidian-rest-api-agent/`, включить плагин.

## 2. Получить токен

Откройте **Settings → REST API for Agents**. Токен сгенерирован автоматически. Нажмите **Показать**, затем **Скопировать**.

Сохраните его в переменную окружения:

```bash
export OBSIDIAN_TOKEN="вставьте-токен-сюда"
export OBSIDIAN_HOST="http://127.0.0.1:27125"
```

Добавьте эти строки в `~/.bashrc` или `~/.zshrc`, если пользуетесь часто.

## 3. Проверить соединение

```bash
curl -s "$OBSIDIAN_HOST/health"
# {"status":"ok"}
```

`/health` — единственный эндпоинт, который не требует токена.

## 4. Список файлов

```bash
curl -s -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
     "$OBSIDIAN_HOST/tree" | jq
```

Ответ:

```json
{
  "files": ["notes/hello.md", "projects/roadmap.md"],
  "dirs": ["notes", "projects"],
  "meta": {}
}
```

## 5. Прочитать файл

```bash
curl -s -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
     "$OBSIDIAN_HOST/vault/notes/hello.md"
```

Текст приходит как `text/markdown`. Бинарники — с правильным MIME (`image/png`, `application/pdf`, …).

## 6. Записать файл

```bash
curl -X PUT \
     -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
     -H "Content-Type: text/markdown" \
     --data-binary "# Hello

Первая заметка через API." \
     "$OBSIDIAN_HOST/vault/notes/hello.md"
```

Ответ: `{"ok":true}`.

## 7. Дописать в конец

```bash
curl -X POST \
     -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
     --data-binary "

## Дополнение

Строка добавлена через POST." \
     "$OBSIDIAN_HOST/vault/notes/hello.md"
```

## 8. Поиск

```bash
# Лексический поиск по содержимому
curl -s -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
     "$OBSIDIAN_HOST/search?q=hello&limit=10" | jq

# Regex
curl -s -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
     "$OBSIDIAN_HOST/search?q=^%23%20Hello&mode=regex" | jq

# По тегам (frontmatter + inline)
curl -s -X POST \
     -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"tags":["project","wip"],"op":"and"}' \
     "$OBSIDIAN_HOST/search_by_tags" | jq
```

## 9. Batch-операции

Записать несколько файлов атомарно (при ошибке — откат):

```bash
curl -s -X POST \
     -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "atomic": true,
       "files": [
         {"path": "notes/a.md", "content": "# A"},
         {"path": "notes/b.md", "content": "# B"}
       ]
     }' \
     "$OBSIDIAN_HOST/batch/write" | jq
```

## 10. Загрузить бинарник

```bash
# Способ 1: raw PUT
curl -X PUT \
     -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
     -H "Content-Type: image/png" \
     --data-binary @screenshot.png \
     "$OBSIDIAN_HOST/vault/attachments/screenshot.png"

# Способ 2: JSON base64
B64=$(base64 -w0 screenshot.png)
curl -s -X POST \
     -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
     -H "Content-Type: application/json" \
     -d "{\"path\":\"attachments/screenshot.png\",\"content_base64\":\"$B64\"}" \
     "$OBSIDIAN_HOST/upload" | jq
```

## Полезные однострочники

**Список всех `.md` файлов:**

```bash
curl -s -H "Authorization: Bearer $OBSIDIAN_TOKEN" "$OBSIDIAN_HOST/tree" \
  | jq -r '.files[] | select(endswith(".md"))'
```

**Метаданные файла (frontmatter, hash, mtime, wikilinks):**

```bash
curl -s -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
     "$OBSIDIAN_HOST/meta/notes/hello.md" | jq
```

**Кто ссылается на файл:**

```bash
curl -s -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
     "$OBSIDIAN_HOST/backlinks/notes/hello.md" | jq
```

**Удалить папку вместе с содержимым:**

```bash
curl -X DELETE \
     -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
     "$OBSIDIAN_HOST/folder/old-stuff?recursive=1" | jq
```

**Только пустые папки:**

```bash
curl -X DELETE \
     -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
     "$OBSIDIAN_HOST/folder/empty?empty_only=1" | jq
```

## Обёртка для shell

Добавьте в `~/.bashrc`:

```bash
obs() {
  local method="$1" path="$2"; shift 2
  curl -s -X "$method" \
       -H "Authorization: Bearer $OBSIDIAN_TOKEN" \
       -H "Content-Type: application/json" \
       "$@" "$OBSIDIAN_HOST$path"
}

obsget()   { obs GET "$1"; }
obsread()  { obs GET "/vault/$1"; }
obswrite() { curl -s -X PUT -H "Authorization: Bearer $OBSIDIAN_TOKEN" --data-binary "$2" "$OBSIDIAN_HOST/vault/$1"; }
```

Использование:

```bash
obsget /tree | jq
obsread notes/hello.md
obswrite notes/new.md "# Заголовок"
```

## Что дальше

- Полные контракты — [API.md](API.md).
- Модель безопасности — [../SECURITY.md](../SECURITY.md).
- Если что-то не работает — откройте issue с выводом `curl -v`.
