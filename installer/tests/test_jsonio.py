"""Tests for installer.jsonio: JSON file read/write helpers."""

from __future__ import annotations

import json

from installer.jsonio import load_json_or_empty, write_json


def test_write_json_pretty_utf8_trailing_newline(tmp_path) -> None:
    """Output uses 2-space indent, keeps non-ASCII and ends with a newline."""
    path = tmp_path / "out.json"
    write_json(str(path), {"a": 1, "中文": "值"})
    content = path.read_text(encoding="utf-8")
    assert content == '{\n  "a": 1,\n  "中文": "值"\n}\n'
    assert json.loads(content) == {"a": 1, "中文": "值"}


def test_write_json_two_space_indent(tmp_path) -> None:
    """Nested objects are indented with two spaces per level."""
    path = tmp_path / "out.json"
    write_json(str(path), {"nested": {"b": 2}})
    content = path.read_text(encoding="utf-8")
    assert '"nested": {' in content
    assert '  "b": 2' in content


def test_load_json_or_empty_missing_file(tmp_path) -> None:
    """A missing file yields {} without a warning."""
    assert load_json_or_empty(str(tmp_path / "nope.json"), "读取失败") == {}


def test_load_json_or_empty_invalid_json_warns(tmp_path, capsys) -> None:
    """Invalid JSON yields {} and prints a warning with the failure label."""
    path = tmp_path / "bad.json"
    path.write_text("{not json", encoding="utf-8")
    assert load_json_or_empty(str(path), "读取失败") == {}
    assert "读取失败" in capsys.readouterr().out


def test_load_json_or_empty_reads_valid(tmp_path) -> None:
    """Valid JSON is parsed and returned."""
    path = tmp_path / "ok.json"
    path.write_text('{"a": 1}', encoding="utf-8")
    assert load_json_or_empty(str(path), "读取失败") == {"a": 1}
