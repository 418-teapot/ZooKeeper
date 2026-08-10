"""Terminal output helpers: ANSI colors and styled message printers."""

import sys


class Colors:
    """Collection of ANSI escape codes for terminal output colors."""

    BOLD = "\033[1m"
    RED = "\033[0;31m"
    YELLOW = "\033[0;33m"
    GREEN = "\033[0;32m"
    CYAN = "\033[0;36m"
    NC = "\033[0m"


def info(msg: str) -> None:
    """Print an informational message in green text.

    Args:
        msg: The message content to print.
    """
    print(f"{Colors.GREEN}{msg}{Colors.NC}")


def warn(msg: str) -> None:
    """Print a warning message in yellow text (prefixed with ⚠).

    Args:
        msg: The message content to print.
    """
    print(f"{Colors.YELLOW}⚠ {msg}{Colors.NC}")


def error(msg: str) -> None:
    """Print an error message in red text to stderr (prefixed with ✖).

    Args:
        msg: The message content to print.
    """
    print(f"{Colors.RED}✖ {msg}{Colors.NC}", file=sys.stderr)


def bold(msg: str) -> str:
    """Wrap text with ANSI bold escape codes.

    Args:
        msg: The text to bolden.

    Returns:
        The string wrapped with bold escape codes.
    """
    return f"{Colors.BOLD}{msg}{Colors.NC}"


def header(title: str) -> None:
    """Print a section title with separator lines.

    Args:
        title: The title text.
    """
    print(f"\n{Colors.CYAN}━━━ {title} ━━━{Colors.NC}")
