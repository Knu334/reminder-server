"""Create the allowlisted Lambda ZIP with fixed metadata and byte identity."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import stat
import zipfile

NAMES = ('THIRD_PARTY_NOTICES', 'dist/', 'dist/api.js', 'dist/api.js.map', 'dist/cleanup.js', 'dist/cleanup.js.map')
MAX_COMPRESSED = 50_000_000
MAX_UNPACKED = 250_000_000


def create_package(root: Path, destination: Path) -> dict:
    root, destination = Path(root), Path(destination)
    if '..' in root.parts or '..' in destination.parts:
        raise ValueError('Parent traversal is forbidden')
    for path in (root.absolute(), *root.absolute().parents):
        if path.is_symlink():
            raise ValueError('Symlink staging paths are forbidden')
    if not root.is_dir():
        raise ValueError('Staging root must be a directory')
    if destination.resolve().is_relative_to(root.resolve()):
        raise ValueError('Destination must be outside staging')
    actual = []
    for path in root.rglob('*'):
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise ValueError('Only regular staging files and directories are allowed')
        name = path.relative_to(root).as_posix() + ('/' if path.is_dir() else '')
        if '\\' in name or name not in NAMES:
            raise ValueError(f'Unexpected archive entry: {name}')
        actual.append(name)
    if sorted(actual) != list(NAMES):
        raise ValueError('Staging must contain exactly the allowed Lambda files')
    unpacked = sum((root / name).stat().st_size for name in NAMES if not name.endswith('/'))
    if unpacked >= MAX_UNPACKED:
        raise ValueError('Unpacked artifact must be below 250 MB')
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in NAMES:
            directory = name.endswith('/')
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = ((stat.S_IFDIR | 0o755) if directory else (stat.S_IFREG | 0o644)) << 16
            if directory:
                info.external_attr |= 0x10
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, b'' if directory else (root / name).read_bytes(), compresslevel=9)
    data = output.getvalue()
    if len(data) >= MAX_COMPRESSED:
        raise ValueError('Compressed artifact must be below 50 MB')
    digest = hashlib.sha256(data).digest()
    identity = {'sha256Hex': digest.hex(), 'sha256Base64': base64.b64encode(digest).decode(),
                'compressedBytes': len(data), 'unpackedBytes': unpacked}
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    return identity


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('artifacts/staging'))
    parser.add_argument('--destination', type=Path, default=Path('artifacts/reminder-server.zip'))
    args = parser.parse_args()
    manifest = create_package(args.root, args.destination)
    (args.destination.parent / 'zip-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest))
