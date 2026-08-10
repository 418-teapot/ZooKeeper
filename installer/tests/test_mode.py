"""Tests for installer.mode: mode-state file path and persistence."""

from __future__ import annotations

import json

from installer.mode import write_mode_state


def test_write_mode_state_creates_dir_and_file(tmp_path) -> None:
    """Writing persists {"mode": <name>} and creates the parent directory."""
    path = tmp_path / "nested" / "mode.json"
    assert write_mode_state("mono", str(path)) is True
    content = json.loads(path.read_text(encoding="utf-8"))
    assert content == {"mode": "mono"}


def test_write_mode_state_failure_warns(tmp_path, capsys) -> None:
    """An unwritable location yields False and a Chinese warning."""
    dir_path = tmp_path / "blocked"
    dir_path.mkdir()
    # Writing over an existing directory path raises OSError.
    assert write_mode_state("mono", str(dir_path)) is False
    assert "写入模式状态文件失败" in capsys.readouterr().out
