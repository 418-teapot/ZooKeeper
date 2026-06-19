"""Shared utilities for wiki CLI tools.

Usage::

    from shared.utils import WIKI_DIR, read_file, all_wiki_pages, ...

The ``shared`` package resolves its parent directory on import so that it can
be found both when tools are invoked directly (``python3 wiki/tools/foo.py``)
and when imported via the dotted package path (``from wiki.tools.shared import
...``).
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure this package's parent directory (wiki/tools/) is on sys.path
# so that ``from shared.utils import ...`` works even when the dotted
# path (wiki.tools.shared) is used from outside the tools directory.
_parent = str(Path(__file__).resolve().parent.parent)
if _parent not in sys.path:
    sys.path.insert(0, _parent)
