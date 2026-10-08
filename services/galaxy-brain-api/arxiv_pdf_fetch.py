"""Bounded private-copy fetcher for exact versioned arXiv PDFs.

The caller supplies a normalized arXiv identifier and version, never a URL.
Redirects remain on the exact canonical arxiv.org PDF path, so this helper is
not a general-purpose server-side fetch primitive.
"""

from __future__ import annotations

import hashlib
import ipaddress
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


ARXIV_PDF_MAX_BYTES = 100_000_000
ARXIV_PDF_MAX_REDIRECTS = 2
ARXIV_PDF_TIMEOUT_SECONDS = 30
ARXIV_PDF_TOTAL_TIMEOUT_SECONDS = 45
ARXIV_PDF_CHUNK_BYTES = 64 * 1024
ARXIV_PDF_MAX_CONCURRENT = 2
ARXIV_PDF_CAPACITY_WAIT_SECONDS = 5
_capacity = threading.BoundedSemaphore(ARXIV_PDF_MAX_CONCURRENT)


class ArxivPdfFetchError(ValueError):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class ArxivPdfFetchResult:
    content: bytes
    content_sha256: str
    source_url: str


class _NoAutomaticRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _canonical_url(arxiv_id: str, version: int) -> str:
    return f"https://arxiv.org/pdf/{arxiv_id}v{version}"


def _safe_url(value: str, arxiv_id: str, version: int) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except (UnicodeError, ValueError) as error:
        raise ArxivPdfFetchError("arXiv redirected outside the canonical PDF origin") from error
    if (
        parsed.scheme != "https"
        or hostname != "arxiv.org"
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
        or parsed.query
        or parsed.fragment
    ):
        raise ArxivPdfFetchError("arXiv redirected outside the canonical PDF origin")
    expected_path = f"/pdf/{arxiv_id}v{version}"
    if parsed.path not in {expected_path, f"{expected_path}.pdf"}:
        raise ArxivPdfFetchError("arXiv redirected outside the canonical PDF path")
    return urllib.parse.urlunsplit(("https", "arxiv.org", parsed.path, "", ""))


def _content_type(headers: Any) -> str:
    if hasattr(headers, "get_content_type"):
        return str(headers.get_content_type()).lower()
    return str(headers.get("Content-Type", "")).split(";", 1)[0].strip().lower()


def _assert_public_dns(hostname: str, resolver: Any) -> None:
    try:
        addresses = resolver(hostname, 443, type=socket.SOCK_STREAM)
    except Exception as error:
        raise ArxivPdfFetchError("The arXiv PDF host could not be resolved") from error
    if not addresses:
        raise ArxivPdfFetchError("The arXiv PDF host could not be resolved")
    for address in addresses:
        try:
            parsed = ipaddress.ip_address(address[4][0].split("%", 1)[0])
        except (IndexError, ValueError) as error:
            raise ArxivPdfFetchError("The arXiv PDF host resolved unexpectedly") from error
        if parsed.version == 6 and parsed.ipv4_mapped is not None:
            parsed = parsed.ipv4_mapped
        if not parsed.is_global:
            raise ArxivPdfFetchError("The arXiv PDF host resolved outside the public internet")


def _open(opener: Any, request: urllib.request.Request, timeout: float):
    if callable(opener) and not hasattr(opener, "open"):
        return opener(request, timeout=timeout)
    return opener.open(request, timeout=timeout)


def _remaining(deadline: float, clock: Any) -> float:
    remaining = deadline - clock()
    if remaining <= 0:
        raise ArxivPdfFetchError("The arXiv PDF request timed out", 504)
    return remaining


def fetch_arxiv_pdf(
    arxiv_id: str,
    version: int,
    *,
    opener: Any = None,
    resolver: Any = socket.getaddrinfo,
    clock: Any = time.monotonic,
) -> ArxivPdfFetchResult:
    """Fetch one exact PDF into bounded memory for private durable storage."""
    if not isinstance(arxiv_id, str) or not arxiv_id or not isinstance(version, int) or isinstance(version, bool):
        raise ArxivPdfFetchError("arXiv PDF identity is invalid", 422)
    if version < 1 or version > 10_000:
        raise ArxivPdfFetchError("arXiv PDF version is invalid", 422)

    if not _capacity.acquire(timeout=ARXIV_PDF_CAPACITY_WAIT_SECONDS):
        raise ArxivPdfFetchError("arXiv PDF fetch capacity is temporarily exhausted", 503)
    try:
        deadline = clock() + ARXIV_PDF_TOTAL_TIMEOUT_SECONDS
        client = opener or urllib.request.build_opener(_NoAutomaticRedirect())
        source_url = _canonical_url(arxiv_id, version)
        current_url = source_url
        visited = {current_url}
        redirects = 0

        while True:
            remaining = _remaining(deadline, clock)
            _assert_public_dns("arxiv.org", resolver)
            remaining = _remaining(deadline, clock)
            request = urllib.request.Request(current_url, headers={
                "Accept": "application/pdf",
                "Accept-Encoding": "identity",
                "User-Agent": "GalaxyBrain/0.1 private arXiv research import",
            })
            try:
                response = _open(client, request, min(ARXIV_PDF_TIMEOUT_SECONDS, remaining))
            except urllib.error.HTTPError as error:
                try:
                    if error.code not in {301, 302, 303, 307, 308}:
                        raise ArxivPdfFetchError("The arXiv PDF is temporarily unavailable") from error
                    location = error.headers.get("Location")
                    if not location or redirects >= ARXIV_PDF_MAX_REDIRECTS:
                        raise ArxivPdfFetchError("arXiv returned too many PDF redirects") from error
                    try:
                        joined_url = urllib.parse.urljoin(current_url, location)
                    except (UnicodeError, ValueError) as location_error:
                        raise ArxivPdfFetchError(
                            "arXiv redirected outside the canonical PDF origin",
                        ) from location_error
                    next_url = _safe_url(joined_url, arxiv_id, version)
                    if next_url in visited:
                        raise ArxivPdfFetchError("arXiv returned a PDF redirect loop") from error
                    visited.add(next_url)
                    current_url = next_url
                    redirects += 1
                    continue
                finally:
                    error.close()
            except TimeoutError as error:
                raise ArxivPdfFetchError("The arXiv PDF request timed out", 504) from error
            except Exception as error:
                raise ArxivPdfFetchError("The arXiv PDF is temporarily unavailable") from error
            break

        declared_size = None
        try:
            response_url = response.geturl() if hasattr(response, "geturl") else current_url
            _safe_url(response_url, arxiv_id, version)
            status = response.getcode() if hasattr(response, "getcode") else getattr(response, "status", 200)
            if status != 200:
                raise ArxivPdfFetchError("arXiv returned an unexpected PDF response")
            if _content_type(response.headers) != "application/pdf":
                raise ArxivPdfFetchError("arXiv returned an unexpected paper format")
            content_encoding = str(response.headers.get("Content-Encoding", "")).strip().lower()
            if content_encoding not in {"", "identity"}:
                raise ArxivPdfFetchError("arXiv returned an encoded PDF body")

            declared_length = response.headers.get("Content-Length")
            if declared_length is not None:
                try:
                    declared_size = int(declared_length)
                except (TypeError, ValueError) as error:
                    raise ArxivPdfFetchError("arXiv returned an invalid paper size") from error
                if declared_size < 1:
                    raise ArxivPdfFetchError("arXiv returned an invalid paper size")
                if declared_size > ARXIV_PDF_MAX_BYTES:
                    raise ArxivPdfFetchError("Paper PDF exceeds the 100 MB storage limit", 413)

            chunks = bytearray()
            digest = hashlib.sha256()
            while True:
                _remaining(deadline, clock)
                chunk = response.read(ARXIV_PDF_CHUNK_BYTES)
                _remaining(deadline, clock)
                if not chunk:
                    break
                if len(chunks) + len(chunk) > ARXIV_PDF_MAX_BYTES:
                    raise ArxivPdfFetchError("Paper PDF exceeds the 100 MB storage limit", 413)
                chunks.extend(chunk)
                digest.update(chunk)
        finally:
            response.close()
    finally:
        _capacity.release()

    content = bytes(chunks)
    if declared_size is not None and len(content) != declared_size:
        raise ArxivPdfFetchError("arXiv PDF size did not match its declaration")
    if len(content) < 5 or not content.startswith(b"%PDF-"):
        raise ArxivPdfFetchError("arXiv returned bytes that are not a PDF")
    return ArxivPdfFetchResult(
        content=content,
        content_sha256=digest.hexdigest(),
        source_url=source_url,
    )
