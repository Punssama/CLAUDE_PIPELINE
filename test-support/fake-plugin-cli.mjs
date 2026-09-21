// Stand-in for the `claude` CLI in tests of toolkit.mjs (CLAUDE_PIPELINE_CLAUDE): records every call and its working folder, and succeeds.
import fs from 'node:fs';

fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\n');
console.log(`✔ Successfully ran: ${process.argv.slice(2).join(' ')}`);
