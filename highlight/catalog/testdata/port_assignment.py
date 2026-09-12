# -*- coding: utf-8 -*-

from __future__ import annotations

DOCUMENTATION = r"""
---
module: port_assignment
short_description: Persist stable host port assignments
description:
  - Reconciles named host port claims against a persistent Saltbox registry.
  - Treats listening sockets and, when the local Docker daemon is reachable, Docker bindings from running or stopped containers as conflicts.
  - Automatically moves a saved assignment when it conflicts and warns about the change.
author: salty
options:
  base_path:
    description:
      - Base directory under which the Saltbox port registry is stored.
    required: true
    type: path
  namespace:
    description:
      - Logical role or workload group containing the owner.
    required: true
    type: str
  owner:
    description:
      - Stable workload or instance identity.
      - Required when C(state=present) and optional when C(state=absent).
    required: false
    type: str
  state:
    description:
      - Reconcile the owner's complete claim set or release saved claims.
      - C(absent) releases one owner when C(owner) is provided, otherwise the complete namespace.
    choices: [present, absent]
    default: present
    type: str
  claims:
    description:
      - Complete mapping of logical claim names to allocation constraints.
      - Each claim requires C(low_bound), C(high_bound), and a C(protocols) list.
      - C(enabled) is optional, defaults to C(true), and releases a saved claim when C(false).
      - Claims previously saved for the owner but omitted from this mapping are released.
    required: false
    default: {}
    type: dict
requirements:
  - iproute2
  - Docker SDK for Python when Docker is available
notes:
  - The caller must stop its service or remove its container before allocation.
  - When the local Docker daemon is unavailable, allocation uses persistent claims and listening sockets without Docker binding observations.
  - Allocation uses inclusive bounds when a claim has no saved port or its saved port conflicts.
  - A conflict-free saved port remains authoritative even when it is outside the current bounds.
  - A saved-port conflict reassigns within the current bounds and warns.
  - Check mode is not supported.
  - The persistent lock file coordinates Saltbox callers but cannot reserve a port after the module exits.
"""
