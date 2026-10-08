import threading
import unittest
from unittest.mock import patch

import arxiv_client
from arxiv_client import (
    ArxivError,
    arxiv_pdf_redistribution_license,
    get_arxiv_paper,
    normalize_arxiv_id,
    parse_atom_feed,
    parse_oai_license,
)


ATOM = b'''<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2401.01234v2</id>
    <updated>2026-01-02T00:00:00Z</updated><published>2024-01-01T00:00:00Z</published>
    <title>  A bounded paper  </title><summary>Evidence\n for a claim.</summary>
    <author><name>Ada Lovelace</name></author><category term="cs.AI"/>
    <link href="https://arxiv.org/abs/2401.01234v2" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/2401.01234v2" rel="related" type="application/pdf"/>
    <link href="http://creativecommons.org/licenses/by/4.0/" rel="license"/>
    <arxiv:doi>10.1/example</arxiv:doi>
  </entry>
</feed>'''

OAI = b'''<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">
  <GetRecord><record><metadata>
    <arXivRaw xmlns="http://arxiv.org/OAI/arXivRaw/">
      <id>2401.01234</id>
      <license>http://creativecommons.org/licenses/by/4.0/</license>
    </arXivRaw>
  </metadata></record></GetRecord>
</OAI-PMH>'''


class ArxivClientTests(unittest.TestCase):
    def setUp(self):
        with arxiv_client._lock:
            arxiv_client._cache.clear()
            arxiv_client._inflight.clear()
            arxiv_client._next_request_at = 0.0
            arxiv_client._waiter_count = 0

    def test_normalizes_modern_legacy_and_versioned_identifiers(self):
        self.assertEqual(normalize_arxiv_id("https://arxiv.org/abs/2401.01234v2"), ("2401.01234", 2))
        self.assertEqual(normalize_arxiv_id("math.GT/0309136"), ("math.GT/0309136", None))
        with self.assertRaises(ArxivError):
            normalize_arxiv_id("https://example.com/private.pdf")

    def test_parses_bounded_atom_metadata(self):
        parsed = parse_atom_feed(ATOM)
        self.assertEqual(parsed["total"], 1)
        paper = parsed["results"][0]
        self.assertEqual(paper["arxiv_id"], "2401.01234")
        self.assertEqual(paper["arxiv_version"], 2)
        self.assertEqual(paper["authors"], [{"name": "Ada Lovelace"}])
        self.assertEqual(paper["categories"], ["cs.AI"])
        self.assertEqual(paper["title"], "A bounded paper")
        self.assertEqual(paper["abs_url"], "https://arxiv.org/abs/2401.01234v2")
        self.assertEqual(paper["pdf_url"], "https://arxiv.org/pdf/2401.01234v2")
        self.assertEqual(paper["license_url"], "https://creativecommons.org/licenses/by/4.0/")

    def test_pdf_redistribution_requires_an_explicit_supported_license(self):
        for license_url in (
            "https://creativecommons.org/licenses/by/4.0/",
            "https://creativecommons.org/licenses/by-sa/4.0/",
            "https://creativecommons.org/publicdomain/zero/1.0/",
        ):
            with self.subTest(license_url=license_url):
                self.assertEqual(arxiv_pdf_redistribution_license(license_url), license_url)
        for license_url in (
            "https://creativecommons.org/licenses/by-nc/4.0/",
            "https://creativecommons.org/licenses/by-nd/4.0/",
            "https://arxiv.org/licenses/nonexclusive-distrib/1.0/",
            "https://example.com/licenses/by/4.0/",
            None,
        ):
            with self.subTest(license_url=license_url):
                self.assertIsNone(arxiv_pdf_redistribution_license(license_url))

    def test_parses_and_normalizes_oai_license_metadata(self):
        self.assertEqual(parse_oai_license(OAI), "https://creativecommons.org/licenses/by/4.0/")

    def test_exact_paper_import_enriches_atom_metadata_from_oai(self):
        atom_result = parse_atom_feed(ATOM)
        atom_result["results"][0]["license_url"] = None
        with patch.object(arxiv_client, "_request", side_effect=[atom_result, "https://creativecommons.org/licenses/by/4.0/"]) as request:
            paper = get_arxiv_paper("2401.01234v2")

        self.assertEqual(paper["license_url"], "https://creativecommons.org/licenses/by/4.0/")
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args_list[1].kwargs["base_url"], arxiv_client.ARXIV_OAI_URL)
        self.assertIs(request.call_args_list[1].kwargs["parser"], parse_oai_license)

    def test_ignores_untrusted_content_links_in_atom_metadata(self):
        poisoned = ATOM.replace(
            b'https://arxiv.org/pdf/2401.01234v2',
            b'https://example.invalid/private.pdf',
        )
        paper = parse_atom_feed(poisoned)["results"][0]
        self.assertEqual(paper["pdf_url"], "https://arxiv.org/pdf/2401.01234v2")

    def test_response_cache_is_lru_bounded(self):
        with patch.object(arxiv_client, "ARXIV_CACHE_MAX_ENTRIES", 2):
            for query in ("alpha", "beta", "gamma"):
                arxiv_client._request({"search_query": query}, opener=lambda request: ATOM)

        self.assertEqual(len(arxiv_client._cache), 2)
        self.assertFalse(any("alpha" in url for url in arxiv_client._cache))
        self.assertTrue(any("beta" in url for url in arxiv_client._cache))
        self.assertTrue(any("gamma" in url for url in arxiv_client._cache))

    def test_response_cache_actively_discards_expired_entries(self):
        arxiv_client._cache["expired"] = (10.0, {"total": 0, "results": []})
        arxiv_client._cache["fresh"] = (90_000.0, {"total": 0, "results": []})

        with patch.object(arxiv_client.time, "monotonic", return_value=90_001.0):
            arxiv_client._request({"search_query": "new"}, opener=lambda request: ATOM)

        self.assertNotIn("expired", arxiv_client._cache)
        self.assertIn("fresh", arxiv_client._cache)

    def test_duplicate_requests_share_one_upstream_call_without_holding_lock(self):
        started = threading.Event()
        release = threading.Event()
        calls = []
        results = []

        def opener(request):
            calls.append(request.full_url)
            started.set()
            self.assertTrue(release.wait(2))
            return ATOM

        def request():
            results.append(arxiv_client._request({"search_query": "same"}, opener=opener))

        leader = threading.Thread(target=request)
        follower = threading.Thread(target=request)
        leader.start()
        self.assertTrue(started.wait(1))
        follower.start()
        self.assertTrue(arxiv_client._lock.acquire(timeout=0.2), "network I/O must not hold the global mutex")
        arxiv_client._lock.release()
        release.set()
        leader.join(2)
        follower.join(2)

        self.assertFalse(leader.is_alive())
        self.assertFalse(follower.is_alive())
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(results), 2)
        self.assertIs(results[0], results[1])

    def test_distinct_cache_misses_are_bounded_instead_of_queuing_workers(self):
        self.assertEqual(arxiv_client.ARXIV_MAX_INFLIGHT, 1)
        started = threading.Event()
        release = threading.Event()
        failures = []

        def opener(request):
            started.set()
            self.assertTrue(release.wait(2))
            return ATOM

        def leader_request():
            try:
                arxiv_client._request({"search_query": "first"}, opener=opener)
            except Exception as error:  # pragma: no cover - assertion reports thread failures
                failures.append(error)

        leader = threading.Thread(target=leader_request)
        leader.start()
        self.assertTrue(started.wait(1))
        with self.assertRaisesRegex(ArxivError, "capacity"):
            arxiv_client._request({"search_query": "second"}, opener=lambda request: ATOM)
        release.set()
        leader.join(2)

        self.assertFalse(leader.is_alive())
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
