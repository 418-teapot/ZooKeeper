"""Tests for install.py: the install flow and its failure semantics."""

from __future__ import annotations

import json
import subprocess

import pytest

import install


def _write_toml(tmp_path) -> str:
    """Write the minimal config.toml the install flow needs.

    Only ``[zoo.mode.poly]`` matters here: with no host binaries detected
    the flow generates no host config, so the selected profile and the
    mode-state write are the parts under test.

    Args:
        tmp_path: The temporary directory to write into.

    Returns:
        The path of the written TOML file.
    """
    path = tmp_path / "config.toml"
    path.write_text(
        '[zoo.mode.poly]\nagents = ["dolphin"]\n', encoding="utf-8"
    )
    return str(path)


@pytest.fixture()
def no_hosts(tmp_path, monkeypatch):
    """Run install.py with no host binaries and HOME under tmp_path.

    Patching ``HOME`` keeps the mode-state file, the wiki bundle and the
    tools symlink inside the temporary directory instead of the real home.

    Args:
        tmp_path: The pytest temporary directory.
        monkeypatch: The pytest monkeypatch fixture.

    Returns:
        The temporary home directory.
    """
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(install.shutil, "which", lambda _name: None)
    return home


class _FakeCompleted:
    """Stand-in for a successful ``subprocess.run`` result."""

    returncode = 0
    stdout = ""
    stderr = ""


def test_mode_state_failure_aborts_before_success_output(
    tmp_path, no_hosts, monkeypatch, capsys
) -> None:
    """A failed mode-state write aborts the install with a non-zero exit.

    The selected mode is the only record of what was generated, so
    reporting success after a failed write would leave the next run on a
    different profile than the configs just written.
    """
    monkeypatch.setattr(
        install, "write_mode_state", lambda mode, path=None: False
    )
    monkeypatch.setattr(
        install.sys, "argv", ["install.py", _write_toml(tmp_path)]
    )

    with pytest.raises(SystemExit) as excinfo:
        install.main()

    assert excinfo.value.code != 0
    captured = capsys.readouterr()
    assert "安装完成" not in captured.out
    assert "模式状态" in captured.err


def test_successful_install_persists_poly_mode(
    tmp_path, no_hosts, monkeypatch, capsys
) -> None:
    """The default (no flag) install persists poly and reports success."""
    monkeypatch.setattr(
        install.sys, "argv", ["install.py", _write_toml(tmp_path)]
    )
    # The wiki bundle step shells out to zwiki; keep the flow hermetic.
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _FakeCompleted())

    install.main()

    captured = capsys.readouterr()
    assert "安装完成" in captured.out
    state_path = no_hosts / ".zoo" / "mode.json"
    assert json.loads(state_path.read_text(encoding="utf-8")) == {
        "mode": "poly"
    }
