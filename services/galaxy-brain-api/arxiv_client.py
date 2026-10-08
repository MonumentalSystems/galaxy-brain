"""Bounded arXiv Atom metadata client with process-wide polite throttling."""

from __future__ import annotations

import re
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import OrderedDict
from typing import Any, Callable

ARXIV_API_URL = "https://export.arxiv.org/api/query"
ARXIV_OAI_URL = "https://export.arxiv.org/oai2"
ARXIV_ID_PATTERN = re.compile(r"^(?P<base>(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?/[0-9]{7}))(?:v(?P<version>[1-9][0-9]*))?$")
ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV_NS = "{http://arxiv.org/schemas/atom}"
OPENSEARCH = "{http://a9.com/-/spec/opensearch/1.1/}"
ARXIV_RAW = "{http://arxiv.org/OAI/arXivRaw/}"
ARXIV_CACHE_TTL_SECONDS = 86_400
ARXIV_CACHE_MAX_ENTRIES = 256
ARXIV_REQUEST_INTERVAL_SECONDS = 3.0
ARXIV_UPSTREAM_TIMEOUT_SECONDS = 15.0
ARXIV_MAX_INFLIGHT = 1
ARXIV_MAX_WAITERS = 8
_lock = threading.Lock()
_next_request_at = 0.0
_waiter_count = 0
_cache: OrderedDict[str, tuple[float, Any]] = OrderedDict()
_inflight: dict[str, dict[str, Any]] = {}


class ArxivError(ValueError):
    pass


def normalize_arxiv_id(value: str) -> tuple[str, int | None]:
    candidate = value.strip()
    for prefix in ("https://arxiv.org/abs/", "http://arxiv.org/abs/", "arXiv:"):
        if candidate.startswith(prefix):
            candidate = candidate[len(prefix):]
    candidate = candidate.removesuffix(".pdf")
    match = ARXIV_ID_PATTERN.fullmatch(candidate)
    if not match:
        raise ArxivError("arXiv identifier is invalid")
    return match.group("base"), int(match.group("version")) if match.group("version") else None


def _text(entry: ET.Element, name: str) -> str:
    element = entry.find(name)
    return " ".join((element.text or "").split()) if element is not None else ""


def _safe_license_url(value: str | None) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 2_000:
        return None
    parsed = urllib.parse.urlparse(value)
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.username or parsed.password or ":" in parsed.netloc
        or parsed.query or parsed.fragment
    ):
        return None
    hostname = (parsed.hostname or "").lower()
    if hostname != "arxiv.org" and hostname != "creativecommons.org" and not hostname.endswith(".creativecommons.org"):
        return None
    return urllib.parse.urlunparse(("https", hostname, parsed.path, "", "", ""))


def arxiv_pdf_redistribution_license(value: str | None) -> str | None:
    """Return a normalized license only when unmodified PDF redistribution is allowed."""
    safe_url = _safe_license_url(value)
    if not safe_url:
        return None
    parsed = urllib.parse.urlparse(safe_url)
    hostname = (parsed.hostname or "").lower()
    if hostname != "creativecommons.org" and not hostname.endswith(".creativecommons.org"):
        return None
    path = parsed.path.lower()
    if re.fullmatch(r"/licenses/(?:by|by-sa)/[0-9]+(?:\.[0-9]+)+/?", path):
        return safe_url
    if re.fullmatch(r"/publicdomain/zero/[0-9]+(?:\.[0-9]+)+/?", path):
        return safe_url
    return None


def parse_atom_feed(payload: bytes) -> dict[str, Any]:
    if len(payload) > 5_000_000:
        raise ArxivError("arXiv response exceeds the metadata limit")
    try:
        root = ET.fromstring(payload)
    except ET.ParseError as error:
        raise ArxivError("arXiv returned invalid Atom metadata") from error
    results = []
    for entry in root.findall(f"{ATOM}entry")[:50]:
        entry_url = _text(entry, f"{ATOM}id")
        try:
            base_id, version = normalize_arxiv_id(entry_url)
        except ArxivError:
            continue
        links = [item.attrib for item in entry.findall(f"{ATOM}link")]
        license_url = next((item.get("href") for item in links if item.get("rel") == "license"), None)
        authors = []
        for author in entry.findall(f"{ATOM}author"):
            name = _text(author, f"{ATOM}name")
            if name:
                authors.append({"name": name})
        categories = [item.get("term", "") for item in entry.findall(f"{ATOM}category") if item.get("term")]
        results.append({
            "arxiv_id": base_id,
            "arxiv_version": version or 1,
            "title": _text(entry, f"{ATOM}title"),
            "abstract": _text(entry, f"{ATOM}summary"),
            "authors": authors,
            "categories": categories,
            "published_at": _text(entry, f"{ATOM}published") or None,
            "source_updated_at": _text(entry, f"{ATOM}updated") or None,
            # Do not trust arbitrary upstream link targets at the browser boundary.
            "abs_url": f"https://arxiv.org/abs/{base_id}v{version or 1}",
            "pdf_url": f"https://arxiv.org/pdf/{base_id}v{version or 1}",
            "doi": _text(entry, f"{ARXIV_NS}doi") or None,
            "journal_ref": _text(entry, f"{ARXIV_NS}journal_ref") or None,
            "license_url": _safe_license_url(license_url),
        })
    total_text = root.findtext(f"{OPENSEARCH}totalResults", "0")
    return {"total": int(total_text) if total_text.isdigit() else len(results), "results": results}


def parse_oai_license(payload: bytes) -> str | None:
    if len(payload) > 5_000_000:
        raise ArxivError("arXiv response exceeds the metadata limit")
    try:
        root = ET.fromstring(payload)
    except ET.ParseError as error:
        raise ArxivError("arXiv returned invalid OAI metadata") from error
    return _safe_license_url(root.findtext(f".//{ARXIV_RAW}license"))


def _prune_cache(now: float) -> None:
    expired = [
        url for url, (cached_at, _) in _cache.items()
        if now - cached_at >= ARXIV_CACHE_TTL_SECONDS
    ]
    for url in expired:
        _cache.pop(url, None)
    while len(_cache) > ARXIV_CACHE_MAX_ENTRIES:
        _cache.popitem(last=False)


def _request(
    params: dict[str, str],
    *,
    opener: Callable[[urllib.request.Request], bytes] | None = None,
    base_url: str = ARXIV_API_URL,
    parser: Callable[[bytes], Any] = parse_atom_feed,
) -> Any:
    global _next_request_at, _waiter_count
    url = f"{base_url}?{urllib.parse.urlencode(params)}"
    while True:
        leader = False
        wait = 0.0
        with _lock:
            now = time.monotonic()
            _prune_cache(now)
            cached = _cache.get(url)
            if cached:
                _cache.move_to_end(url)
                return cached[1]
            flight = _inflight.get(url)
            if flight is None:
                if len(_inflight) >= ARXIV_MAX_INFLIGHT:
                    raise ArxivError("arXiv request capacity is temporarily exhausted")
                flight = {"event": threading.Event(), "result": None, "error": None}
                _inflight[url] = flight
                leader = True
                if opener is None:
                    request_at = max(now, _next_request_at)
                    wait = request_at - now
                    _next_request_at = request_at + ARXIV_REQUEST_INTERVAL_SECONDS
            else:
                if _waiter_count >= ARXIV_MAX_WAITERS:
                    raise ArxivError("arXiv request capacity is temporarily exhausted")
                _waiter_count += 1

        if leader:
            break
        try:
            if not flight["event"].wait(ARXIV_UPSTREAM_TIMEOUT_SECONDS + ARXIV_REQUEST_INTERVAL_SECONDS * ARXIV_MAX_INFLIGHT):
                raise ArxivError("arXiv metadata request timed out")
        finally:
            with _lock:
                _waiter_count -= 1
        if flight["error"] is not None:
            raise flight["error"]
        if flight["result"] is not None:
            return flight["result"]

    request = urllib.request.Request(url, headers={
        "Accept": "application/atom+xml",
        "User-Agent": "GalaxyBrain/0.1 arXiv metadata client",
    })
    try:
        if wait > 0:
            time.sleep(wait)
        if opener is not None:
            payload = opener(request)
        else:
            with urllib.request.urlopen(request, timeout=ARXIV_UPSTREAM_TIMEOUT_SECONDS) as response:
                payload = response.read(5_000_001)
        parsed = parser(payload)
    except Exception as error:
        failure = error if isinstance(error, ArxivError) else ArxivError("arXiv metadata service is unavailable")
        with _lock:
            flight["error"] = failure
            _inflight.pop(url, None)
            flight["event"].set()
        if failure is error:
            raise
        raise failure from error

    with _lock:
        _cache[url] = (time.monotonic(), parsed)
        _cache.move_to_end(url)
        _prune_cache(time.monotonic())
        flight["result"] = parsed
        _inflight.pop(url, None)
        flight["event"].set()
    return parsed


def search_arxiv(query: str, limit: int = 10) -> dict[str, Any]:
    normalized = " ".join(query.split())
    if not 2 <= len(normalized) <= 300:
        raise ArxivError("arXiv search query must contain 2-300 characters")
    bounded_limit = max(1, min(limit, 20))
    escaped = normalized.replace('"', "")
    return _request({
        "search_query": f'all:"{escaped}"',
        "start": "0",
        "max_results": str(bounded_limit),
        "sortBy": "relevance",
        "sortOrder": "descending",
    })


def get_arxiv_paper(arxiv_id: str) -> dict[str, Any]:
    base_id, version = normalize_arxiv_id(arxiv_id)
    requested = f"{base_id}v{version}" if version else base_id
    feed = _request({"id_list": requested, "start": "0", "max_results": "1"})
    if not feed["results"]:
        raise ArxivError("arXiv paper was not found")
    paper = feed["results"][0]
    if paper.get("license_url"):
        return paper
    try:
        license_url = _request({
            "verb": "GetRecord",
            "identifier": f"oai:arXiv.org:{base_id}",
            "metadataPrefix": "arXivRaw",
        }, base_url=ARXIV_OAI_URL, parser=parse_oai_license)
    except ArxivError:
        license_url = None
    return {**paper, "license_url": license_url}
