// Start is a read-only help entry point; it never fabricates production tasks.
import { runCli } from './cli.ts';
process.exitCode = runCli(process.argv.slice(2));
