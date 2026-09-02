#!/usr/bin/env bash
# Fetch BTS On-Time Performance months.
#
# BTS serves these at roughly 50 KB/s per connection, so Node's fetch times out
# long before a 27 MB month lands. curl with resume + retry survives that, and
# running several months at once gets the whole year in one slow-connection's
# worth of wall clock.
#
# Usage: scripts/ingest/ontime.sh <year> <parallel> <month> [month...]
set -uo pipefail

YEAR="${1:?year}"
PARALLEL="${2:?parallel}"
shift 2
MONTHS=("$@")

RAW="$(cd "$(dirname "$0")/../.." && pwd)/data/raw"
BASE="https://transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present"
mkdir -p "$RAW"

fetch_month() {
  local m="$1"
  local csv="$RAW/ontime_${YEAR}_${m}.csv"
  local zip="$RAW/ontime_${YEAR}_${m}.zip"

  if [ -s "$csv" ]; then
    echo "  skip   ontime_${YEAR}_${m}.csv"
    return 0
  fi

  # -C - resumes a partial file; --retry rides out BTS dropping the connection.
  curl -sS --retry 6 --retry-all-errors --retry-delay 5 -C - \
       --speed-limit 1000 --speed-time 120 \
       -o "$zip" "${BASE}_${YEAR}_${m}.zip" || { echo "  FAIL   month $m (download)"; return 1; }

  if ! unzip -tq "$zip" >/dev/null 2>&1; then
    echo "  FAIL   month $m (corrupt zip, removing)"; rm -f "$zip"; return 1
  fi

  local inner
  inner="$(unzip -Z1 "$zip" | grep -i '\.csv$' | head -1)"
  unzip -oj "$zip" "$inner" -d "$RAW" >/dev/null
  mv "$RAW/$(basename "$inner")" "$csv"
  rm -f "$zip"
  echo "  ok     ontime_${YEAR}_${m}.csv ($(du -m "$csv" | cut -f1) MB)"
}

export -f fetch_month
export RAW BASE YEAR

printf '%s\n' "${MONTHS[@]}" | xargs -P "$PARALLEL" -I{} bash -c 'fetch_month "$@"' _ {}

echo "--- on-time files present ---"
ls -1 "$RAW" | grep -c '^ontime_.*\.csv$' | sed 's/^/  months: /'
