"""Private, bounded MarkItDown conversion service."""

import asyncio
import os
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
from importlib.metadata import version
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse


def _bounded_environment_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        return default
    return min(max(value, minimum), maximum)


MAX_FILE_SIZE = _bounded_environment_int("MAX_FILE_SIZE_MB", 50, 1, 100) * 1024 * 1024
MAX_OUTPUT_SIZE = _bounded_environment_int("MARKITDOWN_MAX_OUTPUT_MB", 16, 1, 32) * 1024 * 1024
# The caller's fixed request deadline is 120 seconds. Finish or terminate the
# disposable worker early enough to return a durable fallback receipt before
# that outer deadline expires.
WORKER_TIMEOUT_SECONDS = _bounded_environment_int("MARKITDOWN_TIMEOUT_SECONDS", 105, 5, 110)
MAX_CONCURRENT_WORKERS = _bounded_environment_int("MARKITDOWN_MAX_CONCURRENT_WORKERS", 2, 1, 4)
WORKER_PATH = Path(__file__).with_name("worker.py").resolve()
WORKER_CAPACITY = threading.BoundedSemaphore(MAX_CONCURRENT_WORKERS)

PROXY_TOKEN = os.environ.get("MARKITDOWN_PROXY_TOKEN", "")
MARKITDOWN_ENGINE_VERSION = version("markitdown")

app = FastAPI(title="MarkItDown Conversion Service", version="0.2.0")

# Preserve the established shared converter surface. The durable paper plugin
# is intentionally PDF-only and enforces that boundary before calling here;
# legacy authenticated ingestion still relies on these other MarkItDown types.
SUPPORTED_EXTENSIONS = {
    ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls",
    ".html", ".htm", ".csv", ".json", ".xml",
    ".epub", ".msg", ".eml",
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".webp",
    ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".zip",
}


class ConversionFailure(Exception):
    """An expected worker boundary failure with a safe public diagnostic."""

    def __init__(self, diagnostic: str):
        super().__init__(diagnostic)
        self.diagnostic = diagnostic


@app.middleware("http")
async def require_proxy_token(request: Request, call_next):
    """Only accept conversions from authenticated Galaxy Brain services."""
    if request.url.path == "/health":
        return await call_next(request)
    supplied = request.headers.get("X-GB-Proxy-Token", "")
    if not PROXY_TOKEN:
        return JSONResponse(status_code=503, content={"detail": "service_unavailable"})
    if not secrets.compare_digest(supplied, PROXY_TOKEN):
        return JSONResponse(status_code=401, content={"detail": "invalid_service_credentials"})
    return await call_next(request)


def _terminate_worker(process: subprocess.Popen[bytes]) -> None:
    """Terminate the whole worker process group, then reap the child."""
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def _run_worker(input_path: Path, output_path: Path) -> str:
    """Run one conversion in a disposable child with no inherited stdio."""
    process = subprocess.Popen(
        [
            sys.executable,
            "-I",
            str(WORKER_PATH),
            str(input_path),
            str(output_path),
            str(MAX_OUTPUT_SIZE),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        start_new_session=True,
    )
    try:
        return_code = process.wait(timeout=WORKER_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        _terminate_worker(process)
        raise ConversionFailure("conversion_timeout") from error

    if return_code == 3:
        raise ConversionFailure("conversion_output_too_large")
    if return_code != 0:
        raise ConversionFailure("conversion_failed")

    try:
        output_size = output_path.stat().st_size
    except OSError as error:
        raise ConversionFailure("conversion_failed") from error
    if output_size > MAX_OUTPUT_SIZE:
        raise ConversionFailure("conversion_output_too_large")

    try:
        return output_path.read_bytes().decode("utf-8", errors="strict")
    except UnicodeError as error:
        raise ConversionFailure("conversion_output_invalid") from error
    except OSError as error:
        raise ConversionFailure("conversion_failed") from error


@app.get("/health")
async def health():
    return {"status": "ok", "service": "markitdown"}


@app.post("/convert")
async def convert_file(file: UploadFile = File(...)):
    """Convert one bounded file without executing its parser in the API process."""
    extension = Path(file.filename or "").suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=415, detail="unsupported_file_type")

    content = await file.read(MAX_FILE_SIZE + 1)
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="input_too_large")
    if extension == ".pdf" and not content.startswith(b"%PDF-"):
        raise HTTPException(status_code=415, detail="invalid_pdf")
    if not WORKER_CAPACITY.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="converter_busy", headers={"Retry-After": "5"})

    try:
        with tempfile.TemporaryDirectory(prefix="gb-markitdown-") as temporary_directory:
            directory = Path(temporary_directory)
            input_path = directory / f"input{extension}"
            output_path = directory / "output.md"
            input_path.write_bytes(content)
            try:
                markdown = await asyncio.to_thread(_run_worker, input_path, output_path)
            except ConversionFailure as error:
                status_code = 504 if error.diagnostic == "conversion_timeout" else 422
                raise HTTPException(status_code=status_code, detail=error.diagnostic) from error
    finally:
        WORKER_CAPACITY.release()

    return JSONResponse({
        "filename": file.filename,
        "markdown": markdown,
        "length": len(markdown),
        "engine_version": MARKITDOWN_ENGINE_VERSION,
    })


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("MARKITDOWN_PORT", "8043"))
    uvicorn.run(app, host="0.0.0.0", port=port)
