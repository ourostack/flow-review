#!/usr/bin/env bash
# Installs the system libraries Playwright's WebKit needs on Linux (about 140 MB of packages), from a folder of the
# packages a previous run saved when it has them, and saves what it installed back to it. The Ubuntu mirror the hosted
# runners use is sometimes slow enough to take minutes over them; the folder is kept between runs with actions/cache.
#   webkit-deps.sh <folder> <playwright command...>
# Then it checks that the WebKit build in place loads here. Playwright downloads a build for the host's Ubuntu release,
# so a browser cache saved on another release holds a build that links that release's libraries (Ubuntu 26.04's
# libicudata.so.78 on 24.04, #23): it fetches this release's build in its place.
set -euo pipefail
folder="$1"
shift
mkdir -p "$folder"
if compgen -G "$folder/*.deb" > /dev/null; then sudo cp "$folder"/*.deb /var/cache/apt/archives/; fi
"$@" install-deps webkit
if compgen -G "/var/cache/apt/archives/*.deb" > /dev/null; then cp -u /var/cache/apt/archives/*.deb "$folder"/; fi

# The libraries MiniBrowser can't find, looked up as Playwright looks them up (its own lib folders first). Playwright
# ignores libGLESv2 and libx264, which WebKit only opens when it has them.
missing() {
  local dir
  dir="$("$@" install --dry-run webkit | sed -n 's/^ *Install location: *//p' | head -n 1)"
  local path=""
  for d in minibrowser-gtk minibrowser-gtk/lib minibrowser-gtk/sys/lib minibrowser-wpe minibrowser-wpe/lib minibrowser-wpe/sys/lib; do
    path="$path${path:+:}$dir/$d"
  done
  for bin in "$dir"/minibrowser-*/bin/MiniBrowser; do
    [ -f "$bin" ] || continue
    LD_LIBRARY_PATH="$path" ldd "$bin" 2> /dev/null | grep 'not found' | grep -vE 'libGLESv2|libx264' || true
  done
}
gone="$(missing "$@")"
if [ -n "$gone" ]; then
  echo "::warning title=WebKit build::the WebKit build in place doesn't load on this image, so it is fetched again: $(echo "$gone" | awk '{print $1}' | sort -u | paste -sd ' ')"
  "$@" install --force webkit
  gone="$(missing "$@")"
  if [ -n "$gone" ]; then echo "::error title=WebKit build::WebKit still can't load: $gone"; exit 1; fi
fi
