"""Tests for installer.backup: centralized config backups with rotation."""

from __future__ import annotations

import os

from installer.backup import (
    BACKUP_KEEP,
    backup_file,
    backups_root,
    prune_backups,
)


def _seed_backups(src_path: str, host: str, root, count: int) -> None:
    """Write *count* backups with increasing timestamps via backup_file."""
    for i in range(count):
        backup_file(
            src_path,
            host,
            root=str(root),
            timestamp=f"202608111500{i:02d}",
        )


def test_backups_root_defaults_to_home() -> None:
    """The default backup root is ~/.zoo/backups."""
    assert backups_root() == os.path.join(
        os.path.expanduser("~"), ".zoo", "backups"
    )


def test_backup_file_existing_source_creates_named_backup(tmp_path) -> None:
    """An existing source is copied into <root>/<host> as <name>.bak.<ts>."""
    src = tmp_path / "conf" / "settings.json"
    src.parent.mkdir()
    src.write_text('{"a": 1}', encoding="utf-8")

    dest = backup_file(
        str(src),
        "pi",
        root=str(tmp_path / "root"),
        timestamp="20260811150000",
    )

    assert dest == str(
        tmp_path / "root" / "pi" / "settings.json.bak.20260811150000"
    )
    assert (tmp_path / "root" / "pi").is_dir()
    assert (
        tmp_path / "root" / "pi" / "settings.json.bak.20260811150000"
    ).read_text(encoding="utf-8") == '{"a": 1}'


def test_backup_file_never_writes_next_to_source(tmp_path) -> None:
    """No .bak file appears in the source file's own directory."""
    src = tmp_path / "conf" / "settings.json"
    src.parent.mkdir()
    src.write_text("{}", encoding="utf-8")

    backup_file(str(src), "pi", root=str(tmp_path / "root"))

    assert list((tmp_path / "conf").iterdir()) == [src]


def test_backup_file_missing_source_creates_nothing(tmp_path) -> None:
    """A missing source file yields None and creates no backup directory."""
    root = tmp_path / "root"
    src = tmp_path / "conf" / "missing.json"

    assert backup_file(str(src), "opencode", root=str(root)) is None
    assert not (root / "opencode").exists()


def test_prune_keeps_newest_ten_and_deletes_oldest(tmp_path) -> None:
    """With 12 backups, pruning removes the 2 oldest and keeps the newest 10."""
    src = tmp_path / "conf" / "settings.json"
    src.parent.mkdir()
    src.write_text("{}", encoding="utf-8")
    root = tmp_path / "root"
    _seed_backups(str(src), "pi", root, 12)

    removed = prune_backups(str(src), "pi", root=str(root))

    remaining = sorted(
        p.name for p in (root / "pi").glob("settings.json.bak.*")
    )
    assert removed == 2
    assert len(remaining) == 10
    assert remaining[0] == "settings.json.bak.20260811150002"
    assert remaining[-1] == "settings.json.bak.20260811150011"


def test_prune_at_limit_keeps_all(tmp_path) -> None:
    """At or below BACKUP_KEEP backups nothing is deleted."""
    src = tmp_path / "conf" / "settings.json"
    src.parent.mkdir()
    src.write_text("{}", encoding="utf-8")
    root = tmp_path / "root"
    _seed_backups(str(src), "pi", root, BACKUP_KEEP)

    assert prune_backups(str(src), "pi", root=str(root)) == 0
    assert len(list((root / "pi").glob("settings.json.bak.*"))) == BACKUP_KEEP


def test_prune_below_limit_keeps_all(tmp_path) -> None:
    """Below BACKUP_KEEP backups nothing is deleted."""
    src = tmp_path / "conf" / "settings.json"
    src.parent.mkdir()
    src.write_text("{}", encoding="utf-8")
    root = tmp_path / "root"
    _seed_backups(str(src), "pi", root, 5)

    assert prune_backups(str(src), "pi", root=str(root)) == 0
    assert len(list((root / "pi").glob("settings.json.bak.*"))) == 5


def test_prune_scoped_to_source_basename(tmp_path) -> None:
    """Pruning one source file leaves other sources' backups untouched."""
    a = tmp_path / "conf" / "a.json"
    b = tmp_path / "conf" / "b.json"
    a.parent.mkdir()
    a.write_text("{}", encoding="utf-8")
    b.write_text("{}", encoding="utf-8")
    root = tmp_path / "root"
    _seed_backups(str(a), "opencode", root, 12)
    _seed_backups(str(b), "opencode", root, 12)

    assert prune_backups(str(a), "opencode", root=str(root)) == 2
    assert len(list((root / "opencode").glob("a.json.bak.*"))) == 10
    assert len(list((root / "opencode").glob("b.json.bak.*"))) == 12


def test_prune_delete_failure_warns_without_abort(
    tmp_path, monkeypatch, capsys
) -> None:
    """A failed removal prints a Chinese warning and does not raise."""
    src = tmp_path / "conf" / "settings.json"
    src.parent.mkdir()
    src.write_text("{}", encoding="utf-8")
    root = tmp_path / "root"
    _seed_backups(str(src), "pi", root, 12)

    def _deny(path: str) -> None:
        raise OSError("permission denied")

    monkeypatch.setattr(os, "remove", _deny)
    assert prune_backups(str(src), "pi", root=str(root)) == 0
    assert "删除旧备份失败" in capsys.readouterr().out
    assert len(list((root / "pi").glob("settings.json.bak.*"))) == 12
