# Saltbox Lint

## Error · ansible-when-list

**Location:** `roles/web/tasks/main.yml:102:9`

Split this conjunction into separate `when` items.

### Current code

```yaml
- name: Show web configuration
  ansible.builtin.debug:
    msg: "{{ web_config }}"
  when: (web_config is defined) and web_enabled
```

### Expected code

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

**1 error in 1 file.**
