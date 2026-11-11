# Test stand-in for $EDITOR: reads one line from its own stdin and appends it to the file given as the last argument.
read -r line
printf '\n<!-- typed: %s -->\n' "$line" >> "$1"
