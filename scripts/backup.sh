#!/usr/bin/env bash
set -euo pipefail

database=${1:?the D1 database to export}
out=${2:?the file to write}
shift 2

tables_worth_restoring="SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'seen_[0-9]*' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT IN ('net_day', 'net_hour') ORDER BY name"

# Silent on purpose: an export prints a link to the plain dump, and this repository's logs are public.
quietly() {
  if ! npx --no-install wrangler d1 "$@" > "$out.log" 2>&1; then
    rm -f "$out.log"
    echo "wrangler d1 $1 failed, and its output stays hidden" >&2
    exit 1
  fi
  rm -f "$out.log"
}

tables=$(npx --no-install wrangler d1 execute "$database" "$@" --json --command "$tables_worth_restoring" 2> /dev/null \
  | node -e 'let text = ""; process.stdin.on("data", (piece) => (text += piece)).on("end", () => console.log(JSON.parse(text)[0].results.map((one) => one.name).join("\n")))')
if [ -z "$tables" ]; then
  echo "the database lists no tables" >&2
  exit 1
fi

picked=()
while IFS= read -r table; do
  picked+=(--table "${table%$'\r'}")
done <<< "$tables"

quietly export "$database" "$@" --no-data --output "$out.schema"
quietly export "$database" "$@" --no-schema "${picked[@]}" --output "$out.data"
cat "$out.schema" "$out.data" > "$out"
rm -f "$out.schema" "$out.data"
