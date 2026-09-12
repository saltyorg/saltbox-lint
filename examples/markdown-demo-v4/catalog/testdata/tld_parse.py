#!/usr/bin/python
# pyright: reportMissingTypeStubs=false, reportUnknownMemberType=false

from __future__ import annotations

DOCUMENTATION = """
---
module: tld_parse
description:
    - Parses a domain name into components needed for DNS record management
    - Extracts the full domain and subdomain portions
    - Uses the tld Python library for parsing
author: salty
requirements:
    - tld==0.13.2
options:
    url:
        description:
            - The domain or URL to parse
        required: true
        type: str
    record:
        description:
            - Optional DNS record to prepend to the URL hostname
        required: false
        type: str
        default: ''
"""
