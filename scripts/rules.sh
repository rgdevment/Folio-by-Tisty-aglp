#!/usr/bin/env bash
set -uo pipefail

status=0
missed=0

amiss() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    printf '::error::%s\n' "$1"
  else
    printf 'x  %s\n' "$1"
  fi
  status=1
  missed=$((missed + 1))
}

went_well() {
  [ -n "${GITHUB_ACTIONS:-}" ] || printf 'ok %s\n' "$1"
}

looked_through() {
  case $2 in
    0) amiss "$1"; return 1 ;;
    1) return 0 ;;
    *) amiss "$3"; return 1 ;;
  esac
}

no_prose_blocks() {
  local found
  found=$(find crates/*/src -name '*.rs' -print0 \
    | xargs -0 awk '
        FNR == 1 { run = 0 }
        /^[[:space:]]*\/\/\// { run = 0; next }
        /^[[:space:]]*\/\// && !/\/\/!|TODO|FIXME|SAFETY|noqa|https?:\/\// { run++; if (run == 4) print FILENAME ":" FNR; next }
        { run = 0 }')
  if [ -n "$found" ]; then
    printf '%s\n' "$found"
    amiss "four lines of comment is prose; that goes in the pull request, not in the source"
  else
    went_well "no prose blocks in the code"
  fi
}

nothing_past_what_a_person_holds() {
  local measured kept skip test_modules now at was before
  measured=$(mktemp)
  skip='node_modules|/tests/|\.test\.'
  test_modules=$(grep -rhA1 '^#\[cfg(test)\]$' crates/*/src --include='*.rs' \
    | grep -oE '#\[path = "[^"]+"\]' | grep -oE '"[^"]+"' | tr -d '"' | sort -u | paste -sd'|' -)
  if [ -n "$test_modules" ]; then
    skip="$skip|$test_modules"
  fi
  find crates/*/src web/src \( -name '*.rs' -o -name '*.ts' -o -name '*.tsx' \) \
    | grep -vE "$skip" \
    | sort | tr '\n' '\0' | xargs -0r wc -l \
    | awk '$2 != "total" { print $1, $2 }' > "$measured"

  if [ ! -s "$measured" ]; then
    rm -f "$measured"
    amiss "no source file was found to measure, so the ceiling was never looked at"
    return
  fi

  kept=$(mktemp)
  tr -d '\015' < .github/oversized.txt > "$kept"

  before=$missed
  while read -r now at; do
    was=$(awk -v at="$at" '$2 == at { last = $1 } END { print last }' "$kept")
    if [ -z "$was" ]; then
      if [ "$now" -gt 1500 ]; then
        amiss "$at is $now lines of code; 1500 is the ceiling. Split it along a seam, or say why it belongs in .github/oversized.txt"
      fi
    elif [ "$now" -gt "$was" ]; then
      amiss "$at was already over the ceiling at $was lines and grew to $now. What is above it only shrinks"
    elif [ "$now" -lt "$was" ]; then
      amiss "$at is down to $now lines from $was. Write that into .github/oversized.txt so it cannot grow back"
    fi
  done < "$measured"

  while read -r _ at; do
    if [ ! -f "$at" ]; then
      amiss "$at is in .github/oversized.txt and no longer exists; take the line out"
    fi
  done < <(tr -d '\015' < .github/oversized.txt)

  rm -f "$measured" "$kept"
  [ "$missed" != "$before" ] || went_well "no file grows past what a person can hold"
}

written_in_english() {
  local spanish='(enlace|lector|lectura|documento|clave|firma|sobre|caduca|limite|nombre|archivo|cuando|donde|hasta|desde|porque|aunque)'
  grep -rnE "\b(fn|let|const|struct|enum|type|mod|function|interface) +([A-Za-z_]*_)?$spanish(_|\b)" \
    crates/*/src web/src --include='*.rs' --include='*.ts' --include='*.tsx'
  looked_through \
    "an identifier is in Spanish; code, comments and test names are English" $? \
    "the source could not be looked through for Spanish identifiers" \
    || return
  grep -rnE "\b$spanish *:" \
    crates/*/src web/src --include='*.rs' --include='*.ts' --include='*.tsx' \
    | grep -v '"'
  looked_through \
    "a field is named in Spanish; code, comments and test names are English" $? \
    "the source could not be looked through for Spanish field names" \
    || return
  grep -rnE '^\s*//.*\b(que|porque|pero|aunque|cuando|donde|seg[uú]n|tambi[eé]n|aqu[ií]|ah[ií]|entonces)\b' \
    crates/*/src web/src --include='*.rs' --include='*.ts' --include='*.tsx'
  looked_through \
    "a comment is in Spanish; code, comments and test names are English" $? \
    "the source could not be looked through for Spanish comments" \
    || return
  grep -rnE '(bail|anyhow|panic|expect|format)!?\(\s*"[^"]*\b(que|porque|pero|cuando|seg[uú]n|tambi[eé]n)\b' \
    crates/*/src --include='*.rs' | grep -v '_test'
  looked_through \
    "an error message is in Spanish; code, comments and error messages are English" $? \
    "the source could not be looked through for Spanish error messages" \
    && went_well "code, comments and error messages in English"
}

both_languages_carry_the_same_documents() {
  local pair one mark a b bad=0
  for pair in "README.md README.es.md" \
    "docs/TERMS.md docs/TERMINOS.md" \
    "docs/PRIVACY.md docs/PRIVACIDAD.md" \
    "docs/SECURITY.md docs/SEGURIDAD.md"; do
    set -- $pair
    for one in "$1" "$2"; do
      if [ ! -f "$one" ]; then
        amiss "$one is not here, so its other language was not compared"
        bad=1
        continue 2
      fi
    done
    for mark in '^#' '```' '^|'; do
      a=$(grep -c -- "$mark" "$1")
      b=$(grep -c -- "$mark" "$2")
      [ "$a" = "$b" ] || { amiss "$1 and $2 differ in '$mark': $a vs $b"; bad=1; }
    done
  done
  [ "$bad" = 1 ] || went_well "both languages carry the same documents"
}

# Each module a file names, after `from`, a bare `import` or `import(`, as: file line module.
named_modules() {
  grep -rnoE "(from|import)[[:space:]]*\(?[[:space:]]*['\"][^'\"]+['\"]" "$@" \
    --include='*.ts' --include='*.tsx' \
    | sed -E "s/^([^:]+):([0-9]+):.*['\"]([^'\"]+)['\"]$/\1 \2 \3/"
}

entered_by_its_doors() {
  local name=$1 said=$2 doors=$3 named out
  named=$(named_modules web/src web/tests)
  [ $? -lt 2 ] || { amiss "the page could not be looked through for how it enters $said"; return; }
  out=$(printf '%s\n' "$named" | awk -v name="$name" -v doors=" $doors " '
    ($3 == name || index($3, name "/") == 1) && index(doors, " " $3 " ") == 0')
  if [ -n "$out" ]; then
    printf '%s\n' "$out"
    amiss "$said is entered other than by $doors"
    return
  fi
  went_well "the page meets $said only at its doors"
}

the_packages_are_entered_by_their_doors() {
  entered_by_its_doors tisty-diagrams "the diagram studio" "tisty-diagrams/read tisty-diagrams/studio"
  entered_by_its_doors tisty-editor "the sheet" "tisty-editor/read tisty-editor/edit tisty-editor/tokens.css tisty-editor/side.css"
}

no_token_kept_in_the_tree() {
  local token='ya29\.[A-Za-z0-9_-]{20,}|1//0[A-Za-z0-9_-]{20,}|GOCSPX-[A-Za-z0-9_-]{20,}|sl\.[A-Za-z0-9_-]{40,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}'
  grep -rnIE "$token" crates web fuzz scripts .github docs \
    --exclude='*.lock' --exclude='package-lock.json' \
    --exclude-dir=target --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=wasm --exclude-dir=build
  looked_through \
    "a provider's token or secret is in the tree; a real one goes up with wrangler secret put or into the repository's secrets" $? \
    "the tree could not be looked through for tokens" \
    && went_well "no provider token or secret is kept in the tree"
}

no_worker_secrets_kept() {
  local kept
  # The pre-commit hook runs this on a copy of the index outside any repository, where every file is staged.
  if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    kept=$(git ls-files -- 'crates/worker/.dev.vars*' 'crates/worker/.env*')
  else
    kept=$(find crates/worker -maxdepth 1 \( -name '.dev.vars*' -o -name '.env*' \))
  fi
  if [ -n "$kept" ]; then
    printf '%s\n' "$kept"
    amiss "a file wrangler reads secrets from is committed; it stays on the machine and the secret goes up with wrangler secret put"
  else
    went_well "no Worker secrets file is committed"
  fi
}

# A rollback puts back code that reads the tables as they were, so a migration may only add to them.
migrations_only_add() {
  local found
  found=$(grep -niE '\b(drop|rename)\b' crates/worker/migrations/*.sql)
  if [ -n "$found" ]; then
    printf '%s\n' "$found"
    amiss "a migration takes something away; the version a rollback puts back would no longer read D1"
  else
    went_well "the Worker's migrations only add to the tables"
  fi
}

cd "$(dirname "$0")/.." || exit 2
no_prose_blocks
the_packages_are_entered_by_their_doors
nothing_past_what_a_person_holds
written_in_english
both_languages_carry_the_same_documents
no_token_kept_in_the_tree
no_worker_secrets_kept
migrations_only_add
exit $status
