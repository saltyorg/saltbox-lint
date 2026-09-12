# Privacy

Saltbox Lint sends no telemetry and makes no network requests. Source buffers,
filenames and diagnostics remain on the machine hosting the workspace extension.
The bundled native CLI reads workspace files and invokes local Git for discovery.
It does not run Ansible, Python, playbooks, lookups or shell commands supplied by
your YAML. Diagnostic details and operational errors can appear in VS Code's
Problems view and Saltbox Lint Output channel; review them before sharing reports.

For Remote SSH, WSL and Dev Containers, processing occurs in that workspace's
remote extension host. VS Code itself and other extensions have separate privacy
policies. Build tools and development SDK downloads do use the network; they are
not included in the installed extension.
