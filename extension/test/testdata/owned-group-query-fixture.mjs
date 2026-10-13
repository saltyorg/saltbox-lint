// @ts-check
const [mode, group] = process.argv.slice(2);
switch (mode) {
  case "live":
  case "zombie":
    process.stdout.write(
      `${group} ${process.pid} ${mode === "live" ? "S" : "Z"}\n`,
    );
    break;
  case "absent":
    process.exitCode = 1;
    break;
  case "empty":
    break;
  case "other-exit":
    process.exitCode = 2;
    break;
  case "stderr":
  case "absent-stderr":
    process.stderr.write("Failure calling sysctl\n");
    process.exitCode = mode === "absent-stderr" ? 1 : 0;
    break;
  case "failed-row":
    process.stdout.write(`${group} ${process.pid} S\n`);
    process.exitCode = 1;
    break;
  case "wrong-group":
    process.stdout.write(`${Number(group) + 1} ${process.pid} S\n`);
    break;
  case "malformed":
    process.stdout.write(`${group} ${process.pid} invalid\n`);
    break;
  case "overflow":
    process.stdout.write("x".repeat(5 * 1024 * 1024));
    break;
  case "hold":
    // A native pipe, rather than a timer, holds this query until release or kill.
    process.stdin.resume();
    break;
  default:
    throw new Error(`Unknown owned group query fixture mode: ${mode}`);
}
