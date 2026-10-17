"""Synthetic archive tests: metadata drift and unintended files must fail delivery."""
import base64
import hashlib
import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

REPO = Path(__file__).resolve().parents[2]
NAMES = ['THIRD_PARTY_NOTICES', 'dist/', 'dist/api.js', 'dist/api.js.map', 'dist/cleanup.js', 'dist/cleanup.js.map']


class PackageTests(unittest.TestCase):
    def setUp(self):
        script = REPO / 'scripts/build/package.py'
        self.assertTrue(script.is_file(), 'deterministic package implementation is missing')
        spec = importlib.util.spec_from_file_location('lambda_package', script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.create_package = module.create_package
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'staging'
        (self.root / 'dist').mkdir(parents=True)
        for name in NAMES:
            if not name.endswith('/'):
                (self.root / name).write_bytes(('synthetic ' + name).encode())

    def test_same_bytes_despite_input_mtime(self):
        first_zip, second_zip = self.base / 'first.zip', self.base / 'second.zip'
        self.create_package(self.root, first_zip)
        for path in self.root.rglob('*'):
            os.utime(path, (1800000000, 1800000000))
            path.chmod(0o700 if path.is_dir() else 0o600)
        self.create_package(self.root, second_zip)
        self.assertEqual(first_zip.read_bytes(), second_zip.read_bytes())

    def test_rejects_path_traversal_symlink_and_extra_entries(self):
        destination = self.base / 'rejected.zip'
        for name in ['.env', 'node_modules', 'dist/extra.js', 'parent/dist/api.js', '..\\escape.js']:
            with self.subTest(name=name):
                extra = self.root / name
                extra.parent.mkdir(parents=True, exist_ok=True)
                extra.write_text('synthetic')
                with self.assertRaises(ValueError):
                    self.create_package(self.root, destination)
                self.assertFalse(destination.exists())
                extra.unlink()
                if name.startswith('parent/'):
                    extra.parent.rmdir()
                    extra.parent.parent.rmdir()
        original = self.root / 'dist/api.js'
        original.unlink()
        original.symlink_to(self.base / 'outside.js')
        with self.assertRaises(ValueError):
            self.create_package(self.root, destination)
        original.unlink()
        original.write_text('synthetic')
        alias = self.base / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.create_package(alias, destination)
        with self.assertRaises(ValueError):
            self.create_package(self.root / '..' / 'staging', destination)
        with self.assertRaises(ValueError):
            self.create_package(self.root, self.root / 'output.zip')

    def test_sizes_hash_modes_and_root_layout(self):
        destination = self.base / 'artifact.zip'
        manifest = self.create_package(self.root, destination)
        raw = destination.read_bytes()
        self.assertEqual(manifest['sha256Hex'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(manifest['sha256Base64'], base64.b64encode(hashlib.sha256(raw).digest()).decode())
        self.assertEqual(manifest['compressedBytes'], len(raw))
        self.assertLess(manifest['compressedBytes'], 50_000_000)
        self.assertLess(manifest['unpackedBytes'], 250_000_000)
        with zipfile.ZipFile(destination) as archive:
            self.assertEqual(archive.namelist(), NAMES)
            self.assertEqual(manifest['unpackedBytes'], sum(i.file_size for i in archive.infolist()))
            for info in archive.infolist():
                self.assertEqual(info.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual(info.create_system, 3)
                self.assertEqual(info.external_attr >> 16, (stat.S_IFDIR | 0o755) if info.is_dir() else (stat.S_IFREG | 0o644))
                self.assertEqual(info.extra, b'')
                self.assertEqual(info.comment, b'')
            self.assertIsNone(archive.testzip())


if __name__ == '__main__':
    unittest.main()
