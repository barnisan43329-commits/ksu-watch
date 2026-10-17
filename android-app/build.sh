#!/usr/bin/env bash
# ============================================================================
#  KsuNiMeet Watch — build the APK from Git Bash, no Gradle.
#
#    bash build.sh
#
#  WHY NO GRADLE. This app has no AndroidX, no Kotlin and no plugins: one
#  Activity, one WebView, and a folder of web files. The manual path
#  (aapt2 -> javac -> d8 -> zipalign -> apksigner) produces exactly the same
#  signed APK without downloading a few hundred megabytes to do it.
#
#  THREE THINGS THAT WILL BITE IF CHANGED:
#
#  1. versionCode / versionName live in app/AndroidManifest.xml and ONLY there.
#     They are not passed to aapt2 link, because an argument there would
#     silently override the manifest and Android would not see an update.
#
#  2. The build happens in /tmp/ksuwatch — a path with NO spaces. d8/R8 throws
#     a NullPointerException on paths that contain spaces, and this project's
#     folder contains both a space and a "+".
#
#  3. The web page is copied into assets/www and loaded from
#     file:///android_asset/www/index.html. That is what makes the app work
#     with no signal: the interface itself is local, not fetched from GitHub.
# ============================================================================
set -euo pipefail

BT=$(ls -d /c/Users/Admin/Android/Sdk/build-tools/* | sort -V | tail -1)
AJ=/c/Users/Admin/Android/Sdk/platforms/android-34/android.jar
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/app"
WEB="$(cd "$ROOT/../web" && pwd)"
OUT="$ROOT"
TMP=/tmp/ksuwatch

if [ ! -f "$AJ" ]; then
  echo "NO android.jar: $AJ  (install platform android-34)" >&2
  exit 1
fi
if [ ! -f "$SRC/ksunimeet.keystore" ]; then
  echo "NO signing key: $SRC/ksunimeet.keystore" >&2
  exit 1
fi

CODE=$(grep -oE 'android:versionCode="[^"]*"' "$SRC/AndroidManifest.xml" | head -1 | sed 's/.*="//; s/"//')
VER=$(grep -oE 'android:versionName="[^"]*"' "$SRC/AndroidManifest.xml" | head -1 | sed 's/.*="//; s/"//')
PKG=$(grep -oE 'package="[^"]*"' "$SRC/AndroidManifest.xml" | head -1 | sed 's/package="//; s/"//')

echo "KsuNiMeet Watch — versionCode $CODE / versionName $VER  ($PKG)"
echo "build-tools: $BT"

rm -rf "$TMP"
mkdir -p "$TMP/classes" "$TMP/dex" "$TMP/gen" "$TMP/assets/www"

# --- the page becomes assets ------------------------------------------------
# Only what ships. tools/ holds the tests, and the sample film is a test
# fixture: neither belongs inside the APK.
echo "[1/8] staging the page into assets/www ..."
for f in index.html style.css app.js config.js icon.svg; do
  if [ ! -f "$WEB/$f" ]; then
    echo "MISSING web/$f" >&2
    exit 1
  fi
  cp -f "$WEB/$f" "$TMP/assets/www/$f"
done
echo "      $(du -sk "$TMP/assets/www" | cut -f1) KB of page"

echo "[2/8] aapt2 compile resources ..."
"$BT/aapt2.exe" compile --dir "$SRC/res" -o "$TMP/res.zip"

echo "[3/8] aapt2 link (manifest + assets) ..."
"$BT/aapt2.exe" link -o "$TMP/base.apk" -I "$AJ" \
  --manifest "$SRC/AndroidManifest.xml" "$TMP/res.zip" \
  -A "$TMP/assets" \
  --min-sdk-version 23 --target-sdk-version 33 \
  --java "$TMP/gen"

# --- asset paths -----------------------------------------------------------
# aapt2 on Windows writes asset entry names with the name separator of the
# build machine: "assets/www\\index.html". A device looks the entry up by
# "www/index.html", so the page is not found and the app opens to a white
# screen. Rewritten here, before zipalign, because this is the last moment the
# archive can be taken apart without touching the signature.
echo "[4/8] normalising asset paths ..."
python - "$TMP/base.apk" "$TMP/clean.apk" <<'PY'
import sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as zi, zipfile.ZipFile(dst, 'w') as zo:
    for it in zi.infolist():
        data = zi.read(it.filename)
        name = it.orig_filename.replace('\\', '/')
        out = zipfile.ZipInfo(name, it.date_time)
        out.compress_type = it.compress_type      # resources.arsc must stay stored
        out.external_attr = it.external_attr
        zo.writestr(out, data)
PY
mv -f "$TMP/clean.apk" "$TMP/base.apk"

echo "[5/8] javac ..."
CP="$AJ:$TMP/gen"
( cd "$SRC/src" && javac --release 8 -Xlint:-options -nowarn \
    -classpath "$CP" -d "$TMP/classes" \
    com/ksunimeet/watch/*.java "$TMP"/gen/com/ksunimeet/watch/R.java )

echo "[6/8] d8 -> classes.dex ..."
D8IN=()
while IFS= read -r c; do D8IN+=("$c"); done < <(find "$TMP/classes" -name '*.class')
java -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 --release --lib "$AJ" \
  --min-api 23 --output "$TMP/dex" "${D8IN[@]}"

echo "[7/8] pack, align ..."
cp -f "$TMP/base.apk" "$TMP/app.apk"
( cd "$TMP/dex" && jar uf "$TMP/app.apk" classes*.dex )
"$BT/zipalign.exe" -p -f 4 "$TMP/app.apk" "$TMP/aligned.apk"

echo "[8/8] sign ..."
java -jar "$BT/lib/apksigner.jar" sign \
  --v1-signing-enabled true --v2-signing-enabled true \
  --ks "$SRC/ksunimeet.keystore" --ks-pass pass:ksunimeet2026 \
  --key-pass pass:ksunimeet2026 \
  --out "$TMP/KsuWatch.apk" "$TMP/aligned.apk"

cp -f "$TMP/KsuWatch.apk" "$OUT/KsuWatch.apk"
SIZE=$(stat -c%s "$OUT/KsuWatch.apk" 2>/dev/null || echo '?')
rm -rf "$TMP"
echo
echo "DONE: $OUT/KsuWatch.apk"
echo "      versionCode $CODE / $VER, $((SIZE/1024)) KB"
