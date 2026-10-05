export function hostInputs(env) {
  const expectedVersion =
    env.SALTBOX_TEST_EXPECTED_VSCODE_VERSION ?? env.VSCODE_VERSION ?? "1.137.0";
  const mode =
    env.SALTBOX_TEST_HOST_MODE ??
    (env.SALTBOX_TEST_DEPENDENCIES === "1"
      ? "dependencies"
      : env.SALTBOX_TEST_QUEUE === "1"
        ? "queue"
        : env.SALTBOX_TEST_ACTIVE_PROJECT === "1"
          ? env.SALTBOX_TEST_SAVE_SCOPE === "1"
            ? "active-project-cache"
            : "active-project"
          : env.SALTBOX_TEST_SAVE_SCOPE === "1"
            ? "save-scope"
            : env.SALTBOX_TEST_DISABLED === "1"
              ? "disabled"
              : env.SALTBOX_TEST_MARKERS === "1"
                ? "markers"
                : env.SALTBOX_TEST_PROFILE === "1"
                  ? "profile"
                  : env.SALTBOX_TEST_QUALIFICATION === "1"
                    ? "qualification"
                    : env.SALTBOX_TEST_REGRESSIONS === "1"
                      ? "regressions"
                      : env.SALTBOX_TEST_UNTRUSTED === "1"
                        ? "untrusted"
                        : "normal");
  return { expectedVersion, mode };
}
