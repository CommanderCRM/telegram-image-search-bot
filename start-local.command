#!/bin/zsh
set -e
unsetopt XTRACE VERBOSE
cd "${0:A:h}"
umask 077
mkdir -p .local
export CLANG_MODULE_CACHE_PATH="$PWD/.local/clang-cache"
helper="$PWD/.local/keychain-helper"
if [[ ! -x .local/prepare-photo || scripts/prepare-photo.swift -nt .local/prepare-photo ]]; then
  swiftc -module-cache-path "$PWD/.local/swift-cache" scripts/prepare-photo.swift -o .local/prepare-photo
fi
if [[ ! -x "$helper" || scripts/keychain.swift -nt "$helper" ]]; then
  swiftc -module-cache-path "$PWD/.local/swift-cache" scripts/keychain.swift -o "$helper"
fi
bot_username=$(node scripts/settings.mjs username)
bot_username="${bot_username#@}"
replace_token=0
bot_args=()
for arg in "$@"; do
  if [[ "$arg" == --replace-token ]]; then
    replace_token=1
  else
    bot_args+=("$arg")
  fi
done
if [[ $replace_token == 0 ]]; then
  if TELEGRAM_BOT_TOKEN=$("$helper" get "$bot_username"); then
    echo 'Токен прочитан из Связки ключей macOS.'
  else
    keychain_status=$?
    if [[ $keychain_status != 44 ]]; then
      echo 'Не удалось прочитать Связку ключей. Разреши доступ или разблокируй её и повтори запуск.' >&2
      exit "$keychain_status"
    fi
    replace_token=1
  fi
fi
if [[ $replace_token == 1 ]]; then
  read -rs 'TELEGRAM_BOT_TOKEN?Bot API token (скрытый ввод, сохранится в Связке ключей): '
  echo
  # zsh print is a builtin: the token is not exposed as another process argument.
  print -rn -- "$TELEGRAM_BOT_TOKEN" | "$helper" put "$bot_username"
  # Read back privately before launching. No secret is printed in the terminal.
  saved_token=$("$helper" get "$bot_username")
  if [[ "$saved_token" != "$TELEGRAM_BOT_TOKEN" ]]; then
    echo 'Не прошла проверка сохранения токена.' >&2
    exit 1
  fi
  unset saved_token
  echo 'Токен сохранён в Связке ключей macOS.'
fi
export TELEGRAM_BOT_TOKEN
echo 'Поиск открыт всем в личной переписке. Бот работает до Ctrl+C; caffeinate предотвращает сон при открытой крышке.'
caffeinate -i node scripts/local-bot.mjs "${bot_args[@]}"
