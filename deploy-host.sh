#!/usr/bin/env bash
# KsuNiMeet Watch — one command that puts everything where it is served from.
#
# language: bash, target: InfinityFree FTP (ftpupload.net), Git Bash or Linux
#
# WHY BOTH HALVES GO TO ONE FOLDER
#
#   php-backend/  ->  <remote>/        the API
#   web/          ->  <remote>/        the page, with config.host.js saved as config.js
#
# Served from the same folder, the page and the API are the same site: no other
# origin, no CORS, no relay, no request allowance but the host's own. That is
# the deployment with nothing in between, and it is why nobody is ever asked
# for a server address.
#
# USAGE
#
#   ./deploy-host.sh                 # php + page
#   ./deploy-host.sh php             # the API only (what a protocol change needs)
#   ./deploy-host.sh page            # the page only
#
# CREDENTIALS
#
# Read from a KEY=VALUE file, in this order:
#   1. $KSU_FTP_ENV if it is set
#   2. ../OLD-SITE-KsuNiMeet/ftp-upload.env   (the account that hosts gt.tc)
#   3. ./ftp-upload.env
#
# REMOTE is the folder for the site, relative to that account's FTP root:
#   $KSU_REMOTE, default ksunimeet.gt.tc/htdocs/watch
#
# Every upload is checked: curl's exit status decides, and the script stops at
# the first failure instead of reporting a deploy that did not happen.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WHAT="${1:-all}"

ENV_FILE="${KSU_FTP_ENV:-}"
for candidate in "$ENV_FILE" "$ROOT/OLD-SITE-KsuNiMeet/ftp-upload.env" "$ROOT/ftp-upload.env"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then ENV_FILE="$candidate"; break; fi
done

if [ -z "${ENV_FILE:-}" ] || [ ! -f "$ENV_FILE" ]; then
  echo "no credentials file found; set KSU_FTP_ENV to one" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${FTP_HOST:?missing FTP_HOST}" "${FTP_USER:?missing FTP_USER}" "${FTP_PASSWORD:?missing FTP_PASSWORD}"
REMOTE="${KSU_REMOTE:-ksunimeet.gt.tc/htdocs/watch}"
BASE="ftp://$FTP_HOST/$REMOTE"

put() { # put <local file> [remote path]
  local src="$1" name="${2:-$(basename "$1")}"
  local want have
  want=$(md5sum < "$src" | cut -d' ' -f1)

  curl -sS --max-time 120 --ftp-create-dirs \
       -u "$FTP_USER:$FTP_PASSWORD" -T "$src" "$BASE/$name" >/dev/null

  # VERIFY, THEN TRY ONCE MORE. This host has been seen to accept a STOR and
  # keep serving the previous file, so "curl exited 0" is not evidence that the
  # deploy happened. The only evidence is the bytes that are there.
  have=$(curl -sS --max-time 120 -u "$FTP_USER:$FTP_PASSWORD" "$BASE/$name" | md5sum | cut -d' ' -f1)
  if [ "$have" != "$want" ]; then
    sleep 2
    curl -sS --max-time 120 -u "$FTP_USER:$FTP_PASSWORD" -T "$src" "$BASE/$name" >/dev/null
    sleep 2
    have=$(curl -sS --max-time 120 -u "$FTP_USER:$FTP_PASSWORD" "$BASE/$name" | md5sum | cut -d' ' -f1)
  fi

  if [ "$have" != "$want" ]; then
    printf '  BAD %-22s did not land (remote md5 %s)\n' "$name" "$have" >&2
    exit 1
  fi
  printf '  up  %-22s %s bytes, verified\n' "$name" "$(wc -c < "$src" | tr -d ' ')"
}

echo "deploying to $BASE  (credentials: $ENV_FILE)"

if [ "$WHAT" = "all" ] || [ "$WHAT" = "php" ]; then
  echo "api:"
  # An explicit remote path on every dotfile: a bare basename would put
  # data/.htaccess on top of the router's .htaccess and 403 the whole site.
  put "$HERE/php-backend/.htaccess" .htaccess
  put "$HERE/php-backend/config.php"
  put "$HERE/php-backend/index.php"
  put "$HERE/php-backend/lib.php"
  put "$HERE/php-backend/api/room.php"
  put "$HERE/php-backend/api/film.php"
  put "$HERE/php-backend/api/sync.php"
  # data/ is created by the app and must survive a deploy: only its guard is sent.
  put "$HERE/php-backend/data/.htaccess" data/.htaccess
fi

if [ "$WHAT" = "all" ] || [ "$WHAT" = "page" ]; then
  echo "page:"
  put "$HERE/web/index.html"
  put "$HERE/web/style.css"
  put "$HERE/web/app.js"
  put "$HERE/web/icon.svg"
  # The same-origin copy: an empty door list means "this very origin".
  put "$HERE/web/config.host.js" config.js
fi

echo "done. open https://ksunimeet.gt.tc/watch/ — no address to type, ever."
