// @ts-check
import { runColdDiagnostics, runNativeHosts } from "./native-hosts.mjs";

if (process.argv.includes("--cold-diagnostics")) {
  await runColdDiagnostics({
    resultsFile: process.env.SALTBOX_TEST_HOST_RESULTS_FILE ?? "",
  });
} else {
  await runNativeHosts({
    resultsFile: process.env.SALTBOX_TEST_HOST_RESULTS_FILE,
  });
}
