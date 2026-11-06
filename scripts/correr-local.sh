#!/usr/bin/env bash
# Alternativa a GitHub Actions: corre el monitor en tu máquina y sube el registro al repo.
# Úsalo desde cron / systemd timer si Volaris bloquea las IPs de GitHub Actions.
set -uo pipefail
cd "$(dirname "$0")/.."

node --env-file-if-exists=.env src/monitor.mjs
estado=$?

git add precios.md precios.csv estado.json 2>/dev/null || true
if ! git diff --cached --quiet; then
  git commit -q -m "Registro de precios (local) $(TZ=America/Mexico_City date '+%Y-%m-%d %H:%M')"
  git pull --rebase -q && git push -q
fi
exit $estado
