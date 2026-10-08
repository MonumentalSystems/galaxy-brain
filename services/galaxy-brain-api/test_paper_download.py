import unittest
from email.message import Message
from unittest.mock import patch

from fastapi import HTTPException

from server import IdentityContext, download_paper


class FakePdfResponse:
    def __init__(self):
        self.headers = Message()
        self.headers["Content-Type"] = "application/pdf"
        self.headers["Content-Length"] = "42"
        self.closed = False

    def read(self, _size):
        return b""

    def close(self):
        self.closed = True


class PaperDownloadTests(unittest.TestCase):
    def test_download_uses_canonical_arxiv_url_and_human_filename(self):
        upstream = FakePdfResponse()
        paper = {
            "id": "10000000-0000-4000-8000-000000000001",
            "arxiv_id": "2404.06147",
            "arxiv_version": 1,
            "title": "Vortex unbinding",
            "authors": [{"name": "A. Researcher"}],
            "published_at": "2024-04-08T00:00:00Z",
            "license_url": "https://creativecommons.org/licenses/by/4.0/",
        }
        identity = IdentityContext(
            tenant_id="20000000-0000-4000-8000-000000000001",
            principal_id="30000000-0000-4000-8000-000000000001",
            principal_kind="human",
        )

        with patch("server._paper_or_404", return_value=paper), patch(
            "server.urllib.request.urlopen", return_value=upstream,
        ) as urlopen:
            response = download_paper(paper["id"], None, identity)

        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://arxiv.org/pdf/2404.06147v1")
        self.assertIn("Vortex unbinding - A. Researcher (2024).pdf", response.headers["content-disposition"])
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.assertEqual(response.headers["x-arxiv-license"], paper["license_url"])
        self.assertIn('<https://arxiv.org/abs/2404.06147v1>; rel="canonical"', response.headers["link"])

    def test_download_rejects_missing_or_noncommercial_licenses_before_fetching(self):
        identity = IdentityContext(
            tenant_id="20000000-0000-4000-8000-000000000001",
            principal_id="30000000-0000-4000-8000-000000000001",
            principal_kind="human",
        )
        paper = {
            "id": "10000000-0000-4000-8000-000000000001",
            "arxiv_id": "2404.06147",
            "arxiv_version": 1,
            "title": "Vortex unbinding",
        }

        for license_url in (None, "https://creativecommons.org/licenses/by-nc/4.0/"):
            paper["license_url"] = license_url
            with self.subTest(license_url=license_url), patch("server._paper_or_404", return_value=paper), patch(
                "server.urllib.request.urlopen",
            ) as urlopen, self.assertRaises(HTTPException) as caught:
                download_paper(paper["id"], None, identity)
            self.assertEqual(caught.exception.status_code, 403)
            urlopen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
