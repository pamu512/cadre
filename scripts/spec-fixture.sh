#!/bin/sh
BRIEF="$*"
echo "$BRIEF" | grep -oE "[a-zA-Z0-9_./-]+\.(txt|js|md)" | sort -u | while read -r f; do
  case "$f" in
    *.txt) mkdir -p "$(dirname "$f")"; printf "greeting from the spec\n" > "$f"; echo "created $f" ;;
    *.js)  mkdir -p "$(dirname "$f")"; printf "function greet(name) { return \`hello \${name}\`; }\nmodule.exports = { greet };\n" > "$f"; echo "created $f" ;;
  esac
done
exit 0
