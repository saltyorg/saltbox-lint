// @ts-check
import { runHostProfile, runHostWorker } from "./host-launcher.mjs";

if (process.env.SALTBOX_TEST_HOST_WORKER === "1") await runHostWorker();
else await runHostProfile();
