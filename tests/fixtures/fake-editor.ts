// Fake $EDITOR for tests. Usage: bun fake-editor.ts <file>
// Appends the contents of FAKE_EDITOR_TEXT_FILE (if set) to the file named by the last argument, then exits with
// Number(FAKE_EDITOR_EXIT ?? 0).
import { appendFileSync, readFileSync } from "node:fs";

const target = process.argv.at(-1)!;
const text = process.env.FAKE_EDITOR_TEXT_FILE;
if (text) appendFileSync(target, readFileSync(text, "utf8"));
process.exit(Number(process.env.FAKE_EDITOR_EXIT ?? 0));
