# Local image search with Telegram

This bot searches images by their OCR text using local E5 embeddings and cosine similarity. It returns up to 20 results as photos without captions. Buttons below the photo let users browse results and show the current position. Anyone can search in a private conversation with the bot.

## Requirements

macOS, Node.js 26, Python 3, and Swift from Command Line Tools. Checks were run on macOS arm64. The bot uses local long polling, so the computer must stay running and have access to Telegram. OCR processing, chat exports, and source images are not included.

## Setup

From the project root:

```sh
npm ci --ignore-scripts
npm run build:native
mkdir -p .local
cp config.example.json .local/config.json
```

Edit `.local/config.json`: set your bot's username without `@`, the absolute path to the single image directory, and the absolute path to your SQLite database. Do not put the token in this JSON file.

The database must contain this table:

```sql
CREATE TABLE images (
  sha256 TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  canonical_path TEXT NOT NULL
);
```

`sha256` is the lowercase SHA-256 hash of the source file; `text` is nonempty OCR text; `canonical_path` is a path relative to the image directory. JPEG, PNG, and WebP are supported. Symbolic links and files with multiple hard links are rejected. The database is trusted local input.

Build the index, downloading the pinned model revision from Hugging Face on the first run:

```sh
node scripts/build-semantic.mjs --download
node scripts/local-bot.mjs --check
./start-local.command
```

`--check` checks that the catalog can be read and its files exist. It does not check Telegram connectivity or semantic search quality. At startup, enter the Bot API token at the hidden terminal prompt. The token is saved in macOS Keychain and read from there on subsequent runs. To replace it, use `./start-local.command --replace-token`. The Keychain namespace is `org.local-image-search.bot-token`; the account is the bot's username.

After changing the database, run `node scripts/build-semantic.mjs` again and restart the bot. Startup is blocked if the database and semantic index do not match. If the bot already has a webhook, normal startup stops; the `--remove-webhook` flag explicitly permits its removal.

To stop the bot, press Ctrl+C in its terminal or run `./stop-local.command` from another terminal. The launcher uses `caffeinate -i`.

## Data and boundaries

Embeddings are computed locally. Explicit model downloads send requests to Hugging Face. During operation, Telegram receives the selected images, service replies, and buttons. OCR text is not added to photos. Photo preparation removes source metadata by re-encoding the image.

The `.local/` directory stores the local database, session search queries, Telegram file IDs, index, model, and compiled helpers. It contains private data. `.gitignore` excludes it, `.tgcloud/`, credentials, sessions, databases, and exports. Do not force-add these files with `git add -f`. Git ignore rules do not protect data that has already been committed.

`node_modules/` is also excluded from Git and the distribution archive. Commit `package.json` and `package-lock.json`; install dependencies locally with `npm ci --ignore-scripts`.

User queries are treated as search text. The bot does not execute user commands or download their attachments. File delivery is restricted by catalog and content checks. These are application restrictions, not operating-system isolation of the macOS process.

## Checks

```sh
npm test
python3 -m unittest discover -s tests -p 'test_keychain.py'
```

Node tests use synthetic data. Launcher tests use a fake Keychain helper; they do not modify the real Keychain by default. Tests do not send Telegram messages.

Shared logic remains in `tgcloud/lib/` for historical reasons. The Telegram Serverless adapter is not included in this distribution. A license for the project's own code has not yet been selected.
