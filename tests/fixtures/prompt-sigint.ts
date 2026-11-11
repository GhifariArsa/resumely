// Asks apply's "Continue? [Y/n]" with a SIGINT handler registered, as apply does on the P3 branch.
import { confirmParsed } from "../../src/commands/prompt";

process.on("SIGINT", () => {
  process.stderr.write("SIGINT-HANDLED\n");
  process.exit(130);
});
const ok = await confirmParsed({ company: "Acme", role: "Dev", requirements: [], nice_to_haves: [], keywords: [], language: "en" }, []);
process.stderr.write(`ANSWERED ${ok}\n`);
