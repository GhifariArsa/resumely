// Test stand-in for $EDITOR: appends a marker to the file given as the last argument.
import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2]!, "\n<!-- edited -->\n");
