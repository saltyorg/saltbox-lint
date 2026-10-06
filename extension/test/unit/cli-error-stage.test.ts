import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, posix, win32 } from "node:path";
import { test } from "node:test";
import { observeCLIErrorStage } from "../host/cli-error-stage.ts";

const unknown = "error_stage_unknown";
const line = "saltbox-lint: open source parent secret_path: secret_error 🦀\n";

test("each classifier prefix belongs to the current Go error boundary", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const literals = [
    "cmd/query.go",
    "lint/query.go",
    "lint/discovery.go",
  ].flatMap((name) =>
    [
      ...readFileSync(resolve(root, name), "utf8").matchAll(
        /fmt\.Errorf\("([^"\n]*)"/gu,
      ),
    ].map((match) => "saltbox-lint: " + match[1]),
  );
  literals.push(
    ...[
      ...readFileSync(
        resolve(root, "editor_process_windows.go"),
        "utf8",
      ).matchAll(/fmt\.Errorf\("([^"\n]*)"/gu),
    ].map((match) => match[1]),
  );
  const classifier = readFileSync(
    resolve(import.meta.dirname, "../host/cli-error-stage.ts"),
    "utf8",
  );
  const rules = [
    ...classifier.matchAll(
      /\[\s*("(?:[^"\\]|\\.)*"),\s*"(error_[a-z_]+)"\s*,?\s*\]/gu,
    ),
  ];
  assert.equal(rules.length, 41);
  for (const rule of rules) {
    const prefix: unknown = JSON.parse(rule[1]);
    assert.ok(typeof prefix === "string");
    assert.equal(
      literals.some((literal) => {
        const variable = literal.indexOf("%");
        return (
          prefix ===
          (variable < 0 ? literal + "\n" : literal.slice(0, variable))
        );
      }),
      true,
      rule[2],
    );
    const observer = observeCLIErrorStage();
    const message = prefix.endsWith("\n")
      ? prefix
      : prefix + "secret_path: secret_error 🦀\n";
    for (const byte of Buffer.from(message))
      observer.observe(Buffer.from([byte]));
    assert.equal(observer.stage(true, 2), rule[2]);
    assert.equal(observer.stage(false, 2), unknown);
    assert.equal(observer.stage(true, 0), unknown);
    assert.equal(observer.stage(true, null), unknown);
    observer.dispose();
    assert.equal(observer.stage(true, 2), unknown);
  }
});

test("classification is independent of chunk boundaries and retains no opaque tail", () => {
  const bytes = Buffer.from(line);
  for (let split = 0; split <= bytes.length; split++) {
    const observer = observeCLIErrorStage();
    observer.observe(bytes.subarray(0, split));
    observer.observe(bytes.subarray(split));
    assert.equal(observer.stage(true, 2), "error_source_parent_open");
    assert.doesNotMatch(JSON.stringify(observer), /secret_path|secret_error/);
  }
});

test("valid Unicode boundaries remain eligible opaque tail content", () => {
  for (const point of [
    0x7e, 0xa0, 0xa1, 0x7ff, 0x800, 0x2027, 0x202f, 0x2030, 0x20a8, 0xe028,
    0xe029, 0x10000, 0x1f980, 0x10ffff,
  ]) {
    const bytes = Buffer.from(
      "saltbox-lint: open source parent " +
        String.fromCodePoint(point) +
        "secret_path: secret_error\n",
    );
    for (let split = 0; split <= bytes.length; split++) {
      const observer = observeCLIErrorStage();
      observer.observe(bytes.subarray(0, split));
      observer.observe(bytes.subarray(split));
      assert.equal(observer.stage(true, 2), "error_source_parent_open");
      assert.doesNotMatch(JSON.stringify(observer), /secret_path|secret_error/);
      observer.dispose();
    }
  }
});

test("unavailable and malformed stderr never acquire an invented stage", () => {
  const cases: unknown[][] = [
    [],
    [undefined],
    [null],
    [line],
    [new DataView(new ArrayBuffer(1))],
    [Buffer.from("private stderr\n")],
    [Buffer.from("prefix " + line)],
    [Buffer.from(line.trimEnd())],
    [Buffer.from(line + "another line\n")],
    [Buffer.from(line.replace("\n", "\r\n"))],
    [Buffer.from(line.replace("secret_error", "\u0000"))],
    [Buffer.from(line.replace("secret_error", "\u007f"))],
    [Buffer.from("saltbox-lint: open source parent \n")],
    [Buffer.from("saltbox-lint: query snapshot exceeds 16 MiB extra\n")],
    [Buffer.from("saltbox-lint: query snapshot exceeds 16 MiB\n"), undefined],
    [
      Buffer.from("saltbox-lint: open source parent "),
      Buffer.from([0xe2, 0x82]),
    ],
  ];
  for (const bytes of [
    [0x80],
    [0xc0, 0x80],
    [0xc2, 0x7f],
    [0xe0, 0x80, 0x80],
    [0xed, 0xa0, 0x80],
    [0xf0, 0x80, 0x80, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xf5, 0x80, 0x80, 0x80],
  ])
    cases.push([
      Buffer.from("saltbox-lint: open source parent "),
      Buffer.from(bytes),
      Buffer.from("\n"),
    ]);
  for (const chunks of cases) {
    const observer = observeCLIErrorStage();
    for (const chunk of chunks) observer.observe(chunk);
    assert.equal(observer.stage(true, 2), unknown);
  }
});

test("stderr classification has an exact bound independent of the product output limit", () => {
  const prefix = "saltbox-lint: open source parent ";
  for (const extra of [0, 1]) {
    const observer = observeCLIErrorStage();
    observer.observe(Buffer.from(prefix));
    observer.observe(
      Buffer.alloc(256 * 1024 - prefix.length - 1 + extra, 0x78),
    );
    observer.observe(Buffer.from("\n"));
    assert.equal(
      observer.stage(true, 2),
      extra ? unknown : "error_source_parent_open",
    );
  }
});

function contextFacts(
  message: string | Uint8Array,
  root: unknown = "/fixture",
  platform: NodeJS.Platform = "linux",
) {
  const observer = observeCLIErrorStage(root, platform);
  observer.observe(
    typeof message === "string" ? Buffer.from(message) : message,
  );
  const facts = observer.context(true, 2);
  observer.dispose();
  return facts;
}

const additionalContextRoles = [
  ["example", "example"],
  ["readonly", "readonly"],
  ["readonly-directory", "readonly_directory"],
  ["template-origin", "template_origin"],
] as const;

test("context wrappers retain their exact source-owned formats", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../../../lint/discovery.go"),
    "utf8",
  );
  for (const format of [
    "inspect context %s: %w",
    "resolve source %s: %w",
    "source %s is %w %s",
  ])
    assert.ok(source.includes(`fmt.Errorf("${format}"`));
  assert.ok(source.includes('errors.New("outside root")'));
  assert.ok(source.includes("l.files.Stat(filepath.FromSlash(name))"));
  const owning = readFileSync(
    resolve(import.meta.dirname, "../../../lint/dependencies.go"),
    "utf8",
  );
  const references = readFileSync(
    resolve(import.meta.dirname, "../../../lint/references.go"),
    "utf8",
  );
  assert.ok(
    owning.includes(
      '[]string{"defaults", "tasks", "handlers", "vars", "templates"}',
    ),
  );
  assert.ok(
    references.includes(
      '[]string{"defaults", "vars", "tasks", "handlers", "templates"}',
    ),
  );
  assert.ok(
    references.includes(
      'map[string]bool{"group_vars": true, "host_vars": true, "inventory": true, "inventories": true}',
    ),
  );
});

test("all fixture directory IDs require a complete full-path outer boundary", () => {
  for (const platform of ["linux", "win32"] as const) {
    const root = platform === "win32" ? "C:\\fixture" : "/fixture";
    const paths = platform === "win32" ? win32 : posix;
    const directories = [
      ...["navsource", "navtarget", "resource_navtarget"].flatMap((role) =>
        ["defaults", "vars", "tasks", "handlers", "templates"].map((kind) => [
          `${role}_${kind}`,
          `${role === "resource_navtarget" ? "resources/roles/navtarget" : `roles/${role}`}/${kind}`,
        ]),
      ),
      ...["group_vars", "host_vars", "inventory", "inventories"].map((name) => [
        name,
        name,
      ]),
      ...additionalContextRoles.flatMap(([role, id]) =>
        ["defaults", "vars", "tasks", "handlers", "templates"].map((kind) => [
          `${id}_${kind}`,
          `roles/${role}/${kind}`,
        ]),
      ),
    ];
    assert.equal(directories.length, 39);
    for (const [id, relative] of directories) {
      const absolute = paths.join(root, relative);
      const prefix = `saltbox-lint: inspect context ${absolute}: `;
      assert.deepEqual(
        contextFacts(prefix + "secret_error 🦀\n", root, platform),
        {
          availability: "context_directory_known",
          ambiguous: false,
          directory: id,
          branch: "context_branch_unknown",
          errorTextClass: "text_unknown",
        },
      );
      for (const changed of [
        absolute + "extra",
        absolute.slice(1),
        absolute + paths.sep,
        absolute.replace("fixture", "private_root"),
      ])
        assert.equal(
          contextFacts(
            `saltbox-lint: inspect context ${changed}: secret_error\n`,
            root,
            platform,
          ).directory,
          "directory_unknown",
        );
    }
  }
});

test("root-selected fixture families retain exact nested forms under bytewise observation", () => {
  for (const platform of ["linux", "win32"] as const) {
    const root = platform === "win32" ? "C:\\fixture-é😀" : "/fixture-é😀";
    const paths = platform === "win32" ? win32 : posix;
    for (const [role, id] of additionalContextRoles) {
      for (const kind of [
        "defaults",
        "vars",
        "tasks",
        "handlers",
        "templates",
      ]) {
        const relative = `roles/${role}/${kind}`;
        const absolute = paths.join(root, relative);
        const cases = [
          [
            `statat ${paths.normalize(relative)}: Access is denied.`,
            "context_root_stat",
            "text_permission",
          ],
          [
            `resolve source ${absolute}: ${platform === "win32" ? "CreateFile" : "lstat"} ${absolute}: permission denied`,
            "context_resolve_source",
            "text_permission",
          ],
          [
            `resolve source ${absolute}: readlink ${absolute}: The directory name is invalid.`,
            "context_resolve_source",
            "text_non_directory",
          ],
          [
            `resolve source ${absolute}: EvalSymlinks: too many links`,
            "context_resolve_source",
            "text_symlink_limit",
          ],
          [
            `source ${absolute} is outside root ${root}`,
            "context_outside_root",
            "text_outside_root",
          ],
        ];
        for (const [tail, branch, errorTextClass] of cases) {
          const observer = observeCLIErrorStage(root, platform);
          const bytes = Buffer.from(
            `saltbox-lint: inspect context ${absolute}: ${tail}\n`,
          );
          for (const byte of bytes) observer.observe(Buffer.from([byte]));
          bytes.fill(0);
          assert.deepEqual(observer.context(true, 2), {
            availability: "context_directory_known",
            ambiguous: false,
            directory: `${id}_${kind}`,
            branch,
            errorTextClass,
          });
          assert.equal(observer.stage(true, 2), "error_source_context_inspect");
          assert.equal(
            observer.context(false, 2).directory,
            "directory_unknown",
          );
          assert.equal(
            observer.context(true, 0).directory,
            "directory_unknown",
          );
          observer.dispose();
          assert.equal(
            observer.context(true, 2).directory,
            "directory_unknown",
          );
        }
      }
    }
  }
});

test("added fixture families keep mismatched paths, wrappers and arbitrary roles unknown", () => {
  for (const platform of ["linux", "win32"] as const) {
    const root = platform === "win32" ? "C:\\fixture" : "/fixture";
    const paths = platform === "win32" ? win32 : posix;
    for (const [role, id] of additionalContextRoles) {
      const absolute = paths.join(root, `roles/${role}/templates`);
      const outer = `saltbox-lint: inspect context ${absolute}: `;
      for (const tail of [
        `statat ${paths.normalize(`roles/${role}/tasks`)}: permission denied`,
        `statat ${absolute}: permission denied`,
        `resolve source ${absolute}extra: permission denied`,
        `source ${absolute} is outside root ${root}extra`,
      ]) {
        const facts = contextFacts(outer + tail + "\n", root, platform);
        assert.equal(facts.directory, `${id}_templates`);
        assert.equal(facts.branch, "context_branch_unknown");
        assert.equal(facts.errorTextClass, "text_unknown");
      }
      for (const tail of [
        `resolve source ${absolute}: open ${absolute}: permission denied`,
        `resolve source ${absolute}: readlink private_path: permission denied`,
        `resolve source ${absolute}: permission denied extra`,
        `resolve source ${absolute}: Accès refusé.`,
        `resolve source ${absolute}: secret_credential permission denied`,
      ]) {
        const facts = contextFacts(outer + tail + "\n", root, platform);
        assert.equal(facts.directory, `${id}_templates`);
        assert.equal(facts.branch, "context_resolve_source");
        assert.equal(facts.errorTextClass, "text_unknown");
        assert.doesNotMatch(
          JSON.stringify(facts),
          /private_path|secret_credential|Accès|permission denied/,
        );
      }
      for (const control of ["\0", "\t", "\r", "\u0085", "\u2028", "\u2029"]) {
        const facts = contextFacts(
          outer +
            `statat ${paths.normalize(`roles/${role}/templates`)}: ${control}permission denied\n`,
          root,
          platform,
        );
        assert.equal(facts.directory, "directory_unknown");
      }
    }
    for (const relative of [
      "roles/unknown/defaults",
      "roles/readonly-alias/templates",
      "readonly-alias",
      "resources/roles/example/defaults",
      "roles/template-origin-extra/tasks",
    ]) {
      const absolute = paths.join(root, relative);
      assert.equal(
        contextFacts(
          `saltbox-lint: inspect context ${absolute}: statat ${paths.normalize(relative)}: permission denied\n`,
          root,
          platform,
        ).directory,
        "directory_unknown",
      );
    }
  }
});

test("added fixture families recognize only the known Windows root variants at every split", () => {
  const root = "c:/fixture-é😀";
  for (const [role, id] of additionalContextRoles) {
    for (const spelling of [
      "C:\\fixture-é😀",
      "c:\\fixture-é😀",
      "\\\\?\\C:\\fixture-é😀",
      "\\\\?\\c:\\fixture-é😀",
    ]) {
      const absolute = win32.join(spelling, `roles/${role}/defaults`);
      const bytes = Buffer.from(
        `saltbox-lint: inspect context ${absolute}: statat roles\\${role}\\defaults: The directory name is invalid.\n`,
      );
      for (let split = 0; split <= bytes.length; split++) {
        const observer = observeCLIErrorStage(root, "win32");
        observer.observe(bytes.subarray(0, split));
        observer.observe(bytes.subarray(split));
        assert.deepEqual(observer.context(true, 2), {
          availability: "context_directory_known",
          ambiguous: false,
          directory: `${id}_defaults`,
          branch: "context_root_stat",
          errorTextClass: "text_non_directory",
        });
        observer.dispose();
      }
    }
    for (const changed of [
      "C:\\FIXTUR~1",
      "C:\\private-root",
      "D:\\fixture-é😀",
    ]) {
      const absolute = win32.join(changed, `roles/${role}/defaults`);
      assert.equal(
        contextFacts(
          `saltbox-lint: inspect context ${absolute}: statat roles\\${role}\\defaults: permission denied\n`,
          root,
          "win32",
        ).directory,
        "directory_unknown",
      );
    }
  }
});

test("nested branch and text comparisons survive every byte split in Unicode fixture roots", () => {
  for (const platform of ["linux", "win32"] as const) {
    const root = platform === "win32" ? "C:\\fixture-é😀" : "/fixture-é😀";
    const paths = platform === "win32" ? win32 : posix;
    const absolute = paths.join(root, "roles/navsource/handlers");
    const outer = `saltbox-lint: inspect context ${absolute}: `;
    const cases = [
      [
        "statat " +
          paths.normalize("roles/navsource/handlers") +
          ": Access is denied.",
        "context_root_stat",
        "text_permission",
      ],
      [
        `resolve source ${absolute}: ${platform === "win32" ? "CreateFile" : "lstat"} ${absolute}: permission denied`,
        "context_resolve_source",
        "text_permission",
      ],
      [
        `resolve source ${absolute}: readlink ${absolute}: secret_error 🦀`,
        "context_resolve_source",
        "text_unknown",
      ],
      [
        `resolve source ${absolute}: EvalSymlinks: too many links`,
        "context_resolve_source",
        "text_symlink_limit",
      ],
      [
        `source ${absolute} is outside root ${root}`,
        "context_outside_root",
        "text_outside_root",
      ],
    ];
    for (const [tail, branch, errorTextClass] of cases) {
      const bytes = Buffer.from(outer + tail + "\n");
      for (let split = 0; split <= bytes.length; split++) {
        const observer = observeCLIErrorStage(root, platform);
        observer.observe(bytes.subarray(0, split));
        observer.observe(bytes.subarray(split));
        assert.deepEqual(observer.context(true, 2), {
          availability: "context_directory_known",
          ambiguous: false,
          directory: "navsource_handlers",
          branch,
          errorTextClass,
        });
        assert.equal(observer.context(false, 2).directory, "directory_unknown");
        assert.equal(observer.context(true, 0).directory, "directory_unknown");
        assert.doesNotMatch(
          JSON.stringify(observer.context(true, 2)),
          /fixture|secret_error|permission denied|🦀/,
        );
        observer.dispose();
        assert.equal(observer.context(true, 2).directory, "directory_unknown");
      }
    }
  }
});

test("Windows variants are exact spellings of the same known root", () => {
  const root = "c:/fixture-é😀";
  for (const spelling of [
    "C:\\fixture-é😀",
    "c:\\fixture-é😀",
    "\\\\?\\C:\\fixture-é😀",
    "\\\\?\\c:\\fixture-é😀",
  ]) {
    const absolute = win32.join(spelling, "group_vars");
    assert.equal(
      contextFacts(
        `saltbox-lint: inspect context ${absolute}: statat group_vars: The directory name is invalid.\n`,
        root,
        "win32",
      ).errorTextClass,
      "text_non_directory",
    );
  }
  const unc = "\\\\server\\share\\fixture";
  for (const spelling of [unc, "\\\\?\\UNC\\server\\share\\fixture"])
    assert.equal(
      contextFacts(
        `saltbox-lint: inspect context ${win32.join(spelling, "inventory")}: statat inventory: private_error\n`,
        unc,
        "win32",
      ).directory,
      "inventory",
    );
  assert.equal(
    contextFacts(
      "saltbox-lint: inspect context C:\\FIXTUR~1\\group_vars: statat group_vars: Access is denied.\n",
      root,
      "win32",
    ).directory,
    "directory_unknown",
  );
});

test("nested paths, suffixes and localized messages never acquire a guessed class", () => {
  const absolute = "/fixture/roles/navsource/handlers";
  const outer = `saltbox-lint: inspect context ${absolute}: `;
  const cases = [
    [
      `resolve source ${absolute}extra: lstat ${absolute}: permission denied`,
      "context_branch_unknown",
      "text_unknown",
    ],
    [
      `resolve source private_path: permission denied`,
      "context_branch_unknown",
      "text_unknown",
    ],
    [
      `resolve source ${absolute}: lstat private_path: permission denied`,
      "context_resolve_source",
      "text_unknown",
    ],
    [
      `statat roles/navsource/handlers-extra: permission denied`,
      "context_branch_unknown",
      "text_unknown",
    ],
    [
      `statat ${absolute}: permission denied`,
      "context_branch_unknown",
      "text_unknown",
    ],
    [
      "statat roles/navsource/handlers: Accès refusé.",
      "context_root_stat",
      "text_unknown",
    ],
    [
      "statat roles/navsource/handlers: permission denied extra",
      "context_root_stat",
      "text_unknown",
    ],
    [
      "statat roles/navsource/handlers: secret_value permission denied",
      "context_root_stat",
      "text_unknown",
    ],
    [
      `source ${absolute} is outside root /private_root`,
      "context_branch_unknown",
      "text_unknown",
    ],
    [
      `source ${absolute} is outside root /fixture extra`,
      "context_branch_unknown",
      "text_unknown",
    ],
    [
      "unrelated private_path secret_source_value",
      "context_branch_unknown",
      "text_unknown",
    ],
  ];
  for (const [tail, branch, errorTextClass] of cases) {
    const facts = contextFacts(outer + tail + "\n");
    assert.equal(facts.directory, "navsource_handlers");
    assert.equal(facts.branch, branch);
    assert.equal(facts.errorTextClass, errorTextClass);
    assert.doesNotMatch(
      JSON.stringify(facts),
      /private_path|secret_value|secret_source_value|Accès|permission denied/,
    );
  }
});

test("context comparisons preserve all stderr validity and availability boundaries", () => {
  for (const platform of ["linux", "win32"] as const) {
    const root = platform === "win32" ? "C:\\fixture" : "/fixture";
    const paths = platform === "win32" ? win32 : posix;
    const line = `saltbox-lint: inspect context ${paths.join(root, "group_vars")}: statat group_vars: permission denied\n`;
    assert.equal(
      observeCLIErrorStage().context(true, 2).availability,
      "context_comparison_unavailable",
    );
    for (const root of [
      null,
      "",
      "relative",
      "x".repeat(4097),
      "/" + "é".repeat(2048),
      "/fixture\u0080",
      "/fixture\u2028",
      "/fixture\ud800",
    ])
      assert.equal(
        contextFacts(line, root, platform).availability,
        "context_comparison_unavailable",
      );
    for (const root of platform === "win32"
      ? ["C:\\" + "x".repeat(4093), "C:\\" + "é".repeat(2046) + "x"]
      : ["/" + "x".repeat(4095), "/" + "é".repeat(2047) + "x"])
      assert.equal(
        contextFacts(line, root, platform).availability,
        "context_directory_unknown",
      );
    for (const suffix of [
      "\u0000",
      "\u007f",
      "\u0080",
      "\u009f",
      "\u2028",
      "\u2029",
      "\r",
      "\nextra",
    ])
      assert.equal(
        contextFacts(line.replace("permission denied", suffix), root, platform)
          .directory,
        "directory_unknown",
      );
    for (const message of [
      line.slice(0, -1),
      "prefix " + line,
      line + "extra\n",
      line.replace("group_vars:", "group_vars :"),
      line + "x".repeat(256 * 1024),
    ])
      assert.equal(
        contextFacts(message, root, platform).directory,
        "directory_unknown",
      );
    for (const bad of [
      [0xc2, 0x80],
      [0xe2, 0x80, 0xa8],
      [0xf4, 0x90, 0x80, 0x80],
    ])
      assert.equal(
        contextFacts(
          Buffer.concat([
            Buffer.from(line.slice(0, -1)),
            Buffer.from(bad),
            Buffer.from("\n"),
          ]),
          root,
          platform,
        ).directory,
        "directory_unknown",
      );
    const observer = observeCLIErrorStage(root, platform);
    const bytes = Buffer.from(line);
    observer.observe(bytes);
    bytes.fill(0);
    assert.equal(observer.context(true, 2).errorTextClass, "text_permission");
    observer.observe(undefined);
    assert.equal(observer.context(true, 2).directory, "directory_unknown");
    observer.dispose();
  }
});

test("Windows root comparisons reject drive-relative and incomplete UNC identities", () => {
  for (const root of [
    "\\fixture",
    "C:fixture",
    "C:",
    "\\\\server",
    "\\\\?\\C:fixture",
  ])
    assert.equal(
      contextFacts(
        "saltbox-lint: inspect context private_path: private_error\n",
        root,
        "win32",
      ).availability,
      "context_comparison_unavailable",
    );
});

test("finite error text classes match whole messages only", () => {
  const prefix =
    "saltbox-lint: inspect context C:\\fixture\\host_vars: statat host_vars: ";
  const messages = [
    ["Access is denied.", "text_permission"],
    [
      "The filename, directory name, or volume label syntax is incorrect.",
      "text_invalid_name",
    ],
    ["The directory name is invalid.", "text_non_directory"],
    ["not a directory", "text_non_directory"],
    ["The system cannot find the file specified.", "text_missing_file"],
    ["The system cannot find the path specified.", "text_missing_path"],
    ["no such file or directory", "text_missing_file_or_path"],
    ["path escapes from parent", "text_root_escape"],
    ["too many symlinks", "text_symlink_limit"],
  ];
  for (const [text, code] of messages) {
    assert.equal(
      contextFacts(prefix + text + "\n", "C:\\fixture", "win32").errorTextClass,
      code,
    );
    assert.equal(
      contextFacts(prefix + text + "secret_tail\n", "C:\\fixture", "win32")
        .errorTextClass,
      "text_unknown",
    );
  }
});
