#!/usr/bin/env bash
# Installs the system libraries Playwright's WebKit needs on Linux (about 140 MB of packages), from a folder of the
# packages a previous run saved when it has them, and saves what it installed back to it. The Ubuntu mirror the hosted
# runners use is sometimes slow enough to take minutes over them; the folder is kept between runs with actions/cache.
#   webkit-deps.sh <folder> <playwright command...>
set -euo pipefail
folder="$1"
shift
mkdir -p "$folder"
if compgen -G "$folder/*.deb" > /dev/null; then sudo cp "$folder"/*.deb /var/cache/apt/archives/; fi
"$@" install-deps webkit
if compgen -G "/var/cache/apt/archives/*.deb" > /dev/null; then cp -u /var/cache/apt/archives/*.deb "$folder"/; fi
