# Working on this project

This is a local Telegram bot for macOS. Shared search and button logic lives in `tgcloud/lib/`; the local adapter and media preparation live in `scripts/`. Run `npm test` and the Python unittest command documented in README.

Do not read or include tokens, Keychain contents, or local sessions in reports. Never publish `.local/`, `.tgcloud/`, databases, embeddings, images, logs, or user settings. Use synthetic test data. Do not start the live bot or send Telegram messages unless the user asks you to.

Do not commit `node_modules/`. Keep dependency declarations in `package.json` and the resolved dependency versions in `package-lock.json`.
