// @ts-check
import { runNativeHosts } from "./native-hosts.mjs";

await runNativeHosts({
  resultsFile: process.env.SALTBOX_TEST_HOST_RESULTS_FILE,
});
