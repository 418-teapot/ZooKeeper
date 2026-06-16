"""Tests for zoo-find helper functions and message display.

Tests cover the local ``_preview_text`` function (used in table previews)
and the ``cmd_message`` full-content plain text display.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# ── Import zoo-find as a module (handles hyphen in filename) ──────────────

_TOOLS_DIR = str(Path(__file__).resolve().parent.parent.parent / "tools")
sys.path.insert(0, _TOOLS_DIR)

_loader = importlib.machinery.SourceFileLoader(
    "zoo_find",
    str(Path(_TOOLS_DIR) / "zoo-find"),
)
_spec = importlib.util.spec_from_loader(
    "zoo_find", _loader, origin=str(Path(_TOOLS_DIR) / "zoo-find")
)
_zoo_find = importlib.util.module_from_spec(_spec)
_loader.exec_module(_zoo_find)

_preview_text = _zoo_find._preview_text
cmd_message = _zoo_find.cmd_message

# ── Helpers ───────────────────────────────────────────────────────────────


def _make_msg(
    msg_id: str = "msg_test",
    role: str = "user",
    parts: list[dict] | None = None,
    agent: str = "",
    timestamp: str = "",
) -> dict:
    """Build a minimal message dict like ``query_message_by_ids`` returns."""
    return {
        "id": msg_id,
        "session_id": "sess_test",
        "role": role,
        "agent": agent,
        "timestamp": timestamp,
        "tokens": 100,
        "parts": parts or [],
    }


class FakeArgs:
    """Minimal argparse.Namespace substitute for testing cmd_message."""

    def __init__(self, *, json_output: bool = False) -> None:
        self.message = ["msg_test"]
        self.session = None
        self.scan = 200
        self.json = json_output
        self.no_color = True
        self.db = "/nonexistent/db.sqlite"


# ── _preview_text tests (local copy, no injected-part filtering) ──────────


class TestPreviewText:
    """Tests for the local ``_preview_text()`` in zoo-find."""

    def test_normal_text_part(self) -> None:
        """Returns the first text part's content (no truncation if short)."""
        parts = [{"type": "text", "text": "Hello world"}]
        assert _preview_text(parts) == "Hello world"

    def test_multiline_text_collapses_newlines(self) -> None:
        """Newlines are replaced with spaces in the preview."""
        parts = [{"type": "text", "text": "Hello\nworld\nfoo"}]
        assert _preview_text(parts) == "Hello world foo"

    def test_skips_tool_part_when_text_exists(self) -> None:
        """Text part before a tool part is shown first."""
        parts = [
            {"type": "text", "text": "User query here"},
            {
                "type": "tool",
                "tool": "read",
                "state": {"input": {"filePath": "/tmp/x.txt"}},
            },
        ]
        assert _preview_text(parts) == "User query here"

    def test_truncation_at_40_chars(self) -> None:
        """Text longer than 40 chars is truncated with ellipsis."""
        long_text = "A" * 50
        parts = [{"type": "text", "text": long_text}]
        result = _preview_text(parts)
        assert len(result) == 40  # 37 chars + "..."
        assert result.endswith("...")
        assert result == "A" * 37 + "..."

    def test_tool_part_preview(self) -> None:
        """Tool parts show tool name and first key=value pair."""
        parts = [
            {
                "type": "tool",
                "tool": "read",
                "state": {
                    "input": {"filePath": "/tmp/test.txt"},
                },
            }
        ]
        assert _preview_text(parts) == "read: filePath=/tmp/test.txt"

    def test_tool_with_non_dict_input(self) -> None:
        """Tool with non-dict input shows first 20 chars."""
        parts = [
            {
                "type": "tool",
                "tool": "bash",
                "state": {"input": "ls -la /tmp"},
            }
        ]
        result = _preview_text(parts)
        assert result.startswith("bash:")
        assert len(result) <= 40

    def test_tool_preview_truncated(self) -> None:
        """Long tool preview is truncated to ~40 chars."""
        parts = [
            {
                "type": "tool",
                "tool": "some-long-tool-name",
                "state": {
                    "input": {
                        "veryLongKey": "x" * 50,
                        "secondKey": "y" * 20,
                    }
                },
            }
        ]
        result = _preview_text(parts)
        assert len(result) == 40
        assert result.endswith("...")

    def test_empty_parts_list(self) -> None:
        """Empty parts list returns empty string."""
        assert _preview_text([]) == ""

    def test_reasoning_part_skipped(self) -> None:
        """Reasoning parts are skipped (treated as non-text/non-tool)."""
        parts = [
            {"type": "reasoning", "text": "Chain of thought..."},
            {"type": "text", "text": "Actual answer"},
        ]
        assert _preview_text(parts) == "Actual answer"

    def test_step_finish_part_skipped(self) -> None:
        """Step-finish parts are skipped."""
        parts = [
            {"type": "step-finish", "tokens": {"input": 100}},
            {"type": "text", "text": "Hello"},
        ]
        assert _preview_text(parts) == "Hello"

    def test_synthetic_flag_ignored(self) -> None:
        """Synthetic flag does NOT cause filtering (original non-injected behavior)."""
        parts = [
            {"type": "text", "text": "Synthetic content", "synthetic": True},
        ]
        assert _preview_text(parts) == "Synthetic content"

    def test_system_directive_shown(self) -> None:
        """System directive text is NOT filtered (original behavior)."""
        parts = [
            {
                "type": "text",
                "text": "[SYSTEM DIRECTIVE: FOCUS]\nreminder",
            },
        ]
        result = _preview_text(parts)
        assert result.startswith("[SYSTEM DIRECTIVE:")


# ── cmd_message plain text display tests ──────────────────────────────────


class TestCmdMessagePlainText:
    """Tests for ``cmd_message()`` plain text (non-JSON) output."""

    def _run_cmd(
        self,
        msgs: list[dict],
        args_override: dict | None = None,
    ) -> str:
        """Run ``cmd_message`` and return captured stdout text.

        Patches ``query_message_by_ids`` to return predetermined results,
        and ``sys.stdout`` to capture all output.
        """
        kwargs = {"json_output": False}
        if args_override:
            kwargs.update(args_override)
        args = FakeArgs(**kwargs)

        with (
            patch.object(_zoo_find, "query_message_by_ids", return_value=msgs),
            patch("sys.stdout", new_callable=io.StringIO) as fake_stdout,
        ):
            cmd_message(args)
            return fake_stdout.getvalue()

    def test_empty_parts(self) -> None:
        """Message with no parts shows header only."""
        output = self._run_cmd([_make_msg()])
        assert "Message:" in output
        assert "msg_test" in output
        assert "Role:" in output
        assert "user" in output
        assert "Tokens:" in output
        assert "Part 1" not in output

    def test_text_part_displayed_fully(self) -> None:
        """Full text content is shown without truncation (may wrap)."""
        long_text = (
            "This is a very long message content that should not be "
            "truncated at 40 characters. " * 5
        )
        msgs = [_make_msg(parts=[{"type": "text", "text": long_text}])]
        output = self._run_cmd(msgs)
        # Content is fully present but Rich Console wraps long lines at
        # terminal width; normalize whitespace for the assertion.
        normalized_output = " ".join(output.split())
        normalized_text = " ".join(long_text.split())
        assert normalized_text in normalized_output

    def test_multiple_text_parts(self) -> None:
        """Multiple text parts are all displayed."""
        msgs = [
            _make_msg(
                parts=[
                    {"type": "text", "text": "First part"},
                    {"type": "text", "text": "Second part"},
                ]
            )
        ]
        output = self._run_cmd(msgs)
        assert "Part 1 (text)" in output
        assert "First part" in output
        assert "Part 2 (text)" in output
        assert "Second part" in output

    def test_text_with_newlines_preserved(self) -> None:
        """Newlines in text parts are preserved in output."""
        text = "Line one\nLine two\nLine three"
        msgs = [_make_msg(parts=[{"type": "text", "text": text}])]
        output = self._run_cmd(msgs)
        assert "Line one" in output
        assert "Line two" in output
        assert "Line three" in output

    def test_tool_part_displayed(self) -> None:
        """Tool part shows tool name, input, and output."""
        msgs = [
            _make_msg(
                parts=[
                    {
                        "type": "tool",
                        "tool": "read",
                        "state": {
                            "input": {"filePath": "/tmp/test.txt"},
                            "output": {"content": "file contents here"},
                        },
                    }
                ]
            )
        ]
        output = self._run_cmd(msgs)
        assert "tool: read" in output.lower() or "read" in output
        assert "Input:" in output
        assert "/tmp/test.txt" in output
        assert "Output:" in output
        assert "file contents here" in output

    def test_reasoning_part_displayed(self) -> None:
        """Reasoning part content is shown."""
        msgs = [
            _make_msg(
                parts=[
                    {
                        "type": "reasoning",
                        "text": "Chain of thought steps...",
                    }
                ]
            )
        ]
        output = self._run_cmd(msgs)
        assert "reasoning" in output.lower()
        assert "Chain of thought steps..." in output

    def test_step_finish_skipped(self) -> None:
        """Step-finish parts are skipped and numbering is sequential."""
        msgs = [
            _make_msg(
                parts=[
                    {"type": "step-finish", "tokens": {"input": 100}},
                    {"type": "text", "text": "Visible content"},
                ]
            )
        ]
        output = self._run_cmd(msgs)
        assert "Visible content" in output
        assert "step-finish" not in output
        assert "Part 1 (text)" in output  # sequential, no gap

    def test_unknown_part_type_shown(self) -> None:
        """Unknown part types are shown as JSON."""
        msgs = [
            _make_msg(parts=[{"type": "custom_type", "data": "some_value"}])
        ]
        output = self._run_cmd(msgs)
        assert "custom_type" in output

    def test_agent_and_timestamp_shown(self) -> None:
        """Agent and timestamp fields appear in the header."""
        msgs = [
            _make_msg(
                agent="build",
                timestamp="2025-06-01T12:00:00.000000Z",
            )
        ]
        output = self._run_cmd(msgs)
        assert "Agent:" in output
        assert "build" in output
        assert "Timestamp:" in output
        assert "2025-06-01T12:00:00" in output

    def test_tool_output_truncated_if_long(self) -> None:
        """Very long tool output is truncated at 500 chars."""
        msgs = [
            _make_msg(
                parts=[
                    {
                        "type": "tool",
                        "tool": "bash",
                        "state": {
                            "input": {"command": "echo test"},
                            "output": {"result": "x" * 1000},
                        },
                    }
                ]
            )
        ]
        output = self._run_cmd(msgs)
        # The output line should be truncated (end with ...)
        assert "Output:" in output
        assert "..." in output
        # The value after "Output: " should be <= 504 chars (500 + "...")
        out_line = [
            line
            for line in output.split("\n")
            if line.startswith("    Output:")
        ]
        assert len(out_line) == 1
        out_val = out_line[0].split("    Output: ", 1)[1]
        assert len(out_val) <= 504  # 500 max + "..."

    def test_multiple_messages_all_shown(self) -> None:
        """When multiple messages are returned, all are displayed."""
        msgs = [
            _make_msg(
                msg_id="msg_001", parts=[{"type": "text", "text": "First"}]
            ),
            _make_msg(
                msg_id="msg_002", parts=[{"type": "text", "text": "Second"}]
            ),
        ]
        output = self._run_cmd(msgs)
        assert "msg_001" in output
        assert "msg_002" in output
        assert "First" in output
        assert "Second" in output

    def test_json_output_unaffected(self) -> None:
        """JSON output mode is not affected by the plain text changes."""
        msgs = [_make_msg(parts=[{"type": "text", "text": "Hello"}])]
        with (
            patch.object(_zoo_find, "query_message_by_ids", return_value=msgs),
            patch("sys.stdout", new_callable=io.StringIO) as fake_stdout,
        ):
            args = FakeArgs(json_output=True)
            cmd_message(args)
            output = fake_stdout.getvalue()
        data = json.loads(output)
        assert data["keyword"] == "msg_test"
        assert data["matches"] == 1
        assert data["messages"][0]["id"] == "msg_test"


# ── Entry point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    pytest.main([__file__])
