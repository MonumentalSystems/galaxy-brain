import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path


WORKER_PATH = Path(__file__).with_name("worker.py")
SPEC = importlib.util.spec_from_file_location("galaxy_markitdown_worker", WORKER_PATH)
assert SPEC is not None and SPEC.loader is not None
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class _Result:
    def __init__(self, text_content):
        self.text_content = text_content


class WorkerTest(unittest.TestCase):
    def _install_markitdown(self, text_content):
        module = types.ModuleType("markitdown")

        class FakeMarkItDown:
            def convert(self, _path):
                return _Result(text_content)

        module.MarkItDown = FakeMarkItDown
        previous = sys.modules.get("markitdown")
        sys.modules["markitdown"] = module
        self.addCleanup(
            lambda: sys.modules.__setitem__("markitdown", previous)
            if previous is not None
            else sys.modules.pop("markitdown", None)
        )

    def test_writes_exact_utf8_without_replacement(self):
        self._install_markitdown("# Proof\n\n$\\alpha \\to \\beta$\n")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.pdf"
            output = root / "output.md"
            source.write_bytes(b"%PDF-test")
            self.assertEqual(worker.convert(source, output, 1024), 0)
            self.assertEqual(output.read_text(encoding="utf-8"), "# Proof\n\n$\\alpha \\to \\beta$\n")

    def test_refuses_output_over_cap_without_partial_file(self):
        self._install_markitdown("abcdef")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.pdf"
            output = root / "output.md"
            source.write_bytes(b"%PDF-test")
            self.assertEqual(worker.convert(source, output, 5), 3)
            self.assertFalse(output.exists())

    def test_main_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.pdf"
            output = root / "output.md"
            source.write_bytes(b"%PDF-test")
            output.write_text("existing", encoding="utf-8")
            self.assertEqual(worker.main(["worker.py", str(source), str(output), "1024"]), 2)
            self.assertEqual(output.read_text(encoding="utf-8"), "existing")


if __name__ == "__main__":
    unittest.main()
