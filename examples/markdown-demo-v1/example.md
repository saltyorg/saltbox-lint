# Saltbox Lint

## Error · ansible-when-list

**Location:** `roles/example/tasks/main.yml:4:9`

Split this conjunction into separate `when` items.

### Current code

```yaml
- name: Example
  ansible.builtin.debug:
    msg: ok
  when: (value is defined) and value
```

### Expected code

```yaml
- name: Example
  ansible.builtin.debug:
    msg: ok
  when:
    - (value is defined)
    - value
```

**Fix:** This rule requires a manual change.

---

**1 error in 1 file.**
