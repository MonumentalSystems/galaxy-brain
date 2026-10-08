"""Single-use MarkItDown worker. Exit codes are interpreted by server.py."""

import sys
from pathlib import Path


def convert(input_path: Path, output_path: Path, max_output_bytes: int) -> int:
    from markitdown import MarkItDown

    result = MarkItDown().convert(str(input_path))
    markdown = result.text_content
    if not isinstance(markdown, str):
        return 1
    try:
        encoded = markdown.encode("utf-8", errors="strict")
    except UnicodeError:
        return 1
    if len(encoded) > max_output_bytes:
        return 3
    try:
        with output_path.open("xb") as output:
            output.write(encoded)
    except OSError:
        return 1
    return 0


def main(arguments: list[str]) -> int:
    if len(arguments) != 4:
        return 2
    try:
        input_path = Path(arguments[1]).resolve(strict=True)
        output_path = Path(arguments[2]).resolve(strict=False)
        max_output_bytes = int(arguments[3])
    except (OSError, ValueError):
        return 2
    if max_output_bytes < 1 or output_path.exists() or input_path == output_path:
        return 2
    try:
        return convert(input_path, output_path, max_output_bytes)
    except Exception:
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
