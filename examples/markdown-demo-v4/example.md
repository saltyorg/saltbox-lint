# Saltbox Lint

## roles/web/tasks/main.yml

### Error 1 of 3 · ansible-when-list

**Location:** `roles/web/tasks/main.yml:102:9`

Split this conjunction into separate `when` items.

#### Current code

```saltbox-ansible
{{CURRENT_WHEN}}
```

#### Expected code

```saltbox-ansible
{{EXPECTED_WHEN}}
```

**Fix:** This rule requires a manual change.

---

### Error 2 of 3 · ansible-tag-name

**Location:** `roles/web/tasks/main.yml:148:7`

Use a kebab-case tag: replace `restart_web` with `restart-web`.

#### Current code

```saltbox-ansible
{{CURRENT_TAG}}
```

#### Expected code

```saltbox-ansible
{{EXPECTED_TAG}}
```

**Fix:** This rule requires a manual change.

---

## roles/web/defaults/main.yml

### Error 3 of 3 · section-spacing

**Location:** `roles/web/defaults/main.yml:10:1`

Add a blank line between the section banner and its variables.

#### Current code

```saltbox-ansible
{{CURRENT_SPACING}}
```

#### Expected code

```saltbox-ansible
{{EXPECTED_SPACING}}
```

**Fix:** An automatic formatting fix is available with `check --fix`.

---

**3 errors in 2 files.** An automatic fix is available for **1 finding**.
