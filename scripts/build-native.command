#!/bin/zsh
set -e
cd "${0:A:h:h}"
umask 077
mkdir -p .local
export CLANG_MODULE_CACHE_PATH="$PWD/.local/clang-cache"
for name in keychain prepare-photo; do
  target="$name"
  [[ "$name" == keychain ]] && target=keychain-helper
  if [[ ! -x ".local/$target" || "scripts/$name.swift" -nt ".local/$target" ]]; then
    swiftc -module-cache-path "$PWD/.local/swift-cache" "scripts/$name.swift" -o ".local/$target"
  fi
done
