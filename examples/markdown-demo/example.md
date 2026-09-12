# Saltbox Lint

## roles/web/tasks/main.yml

### Error 1 of 3 · ansible-when-list

**Location:** `roles/web/tasks/main.yml:102:9`

Split this conjunction into separate `when` items.

#### Current code

```yaml
- name: Show web configuration
  ansible.builtin.debug:
    msg: "{{ web_config }}"
  when: (web_config is defined) and web_enabled
```

#### Expected code

```yaml
- name: Show web configuration
  ansible.builtin.debug:
    msg: "{{ web_config }}"
  when:
    - (web_config is defined)
    - web_enabled
```

**Fix:** This rule requires a manual change.

---

### Error 2 of 3 · ansible-tag-name

**Location:** `roles/web/tasks/main.yml:148:7`

Use a kebab-case tag: replace `restart_web` with `restart-web`.

#### Current code

```yaml
- name: Restart web container
  ansible.builtin.debug:
    msg: "Restarting {{ web_name }}"
  tags:
    - restart_web
    - web
```

#### Expected code

```yaml
- name: Restart web container
  ansible.builtin.debug:
    msg: "Restarting {{ web_name }}"
  tags:
    - restart-web
    - web
```

**Fix:** This rule requires a manual change.

---

## roles/web/defaults/main.yml

### Error 3 of 3 · section-spacing

**Location:** `roles/web/defaults/main.yml:10:1`

Add a blank line between the section banner and its variables.

#### Current code

```yaml
################################
# Settings
################################
web_role_enabled: true
web_role_http_port: 8080
web_role_healthcheck_path: /health
web_role_url: "https://{{ web_subdomain }}.{{ web_domain }}"
```

#### Expected code

```yaml
################################
# Settings
################################

web_role_enabled: true
web_role_http_port: 8080
web_role_healthcheck_path: /health
web_role_url: "https://{{ web_subdomain }}.{{ web_domain }}"
```

**Fix:** An automatic formatting fix is available with `check --fix`.

---

**3 errors in 2 files.** An automatic fix is available for **1 finding**.
