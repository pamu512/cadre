#!/bin/sh
# Test builder: create every source path named in the brief. When the line says
# "contains" or "containing", that text is what gets written.
BRIEF="$*"
printf '%s\n' "$BRIEF" | grep -oE '[a-zA-Z0-9_./-]+\.(txt|js|md)' | sort -u | while read -r f; do
  hit=$(printf '%s\n' "$BRIEF" | grep -F "$f" | head -1)
  content=$(printf '%s\n' "$hit" | sed -n 's/.* containing //p; s/.* contains //p')
  mkdir -p "$(dirname "$f")"
  if [ -n "$content" ]; then
    printf '%s\n' "$content" > "$f"
  elif [ "${f##*.}" = "js" ]; then
    printf 'function greet(name) { return `hello ${name}`; }\nmodule.exports = { greet };\n' > "$f"
  else
    printf 'greeting from the spec\n' > "$f"
  fi
  echo "created $f"
done
exit 0
