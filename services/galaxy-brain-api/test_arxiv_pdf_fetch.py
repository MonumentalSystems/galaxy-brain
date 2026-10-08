import io
import unittest
import urllib.error
from email.message import Message
from unittest.mock import patch

from arxiv_pdf_fetch import (
    ARXIV_PDF_MAX_BYTES,
    ArxivPdfFetchError,
    fetch_arxiv_pdf,
)


PDF = b"%PDF-1.7\nprivate research copy\n%%EOF\n"
PUBLIC_RESOLVER = lambda host, port, type: [
    (2, 1, 6, "", ("151.101.3.42", port)),
    (10, 1, 6, "", ("2606:4700::6810:1346", port, 0, 0)),
]


def headers(**values):
    result = Message()
    for key, value in values.items():
        result[key.replace("_", "-")] = str(value)
    return result


class FakeResponse(io.BytesIO):
    def __init__(self, body=PDF, *, url="https://arxiv.org/pdf/2404.06147v1", response_headers=None):
        super().__init__(body)
        self._url = url
        self.headers = response_headers or headers(Content_Type="application/pdf", Content_Length=len(body))
        self.status = 200

    def geturl(self):
        return self._url

    def getcode(self):
        return self.status


class ArxivPdfFetchTests(unittest.TestCase):
    def test_fetches_only_the_exact_versioned_pdf_and_hashes_exact_bytes(self):
        requests = []

        def opener(request, timeout):
            requests.append((request, timeout))
            return FakeResponse()

        result = fetch_arxiv_pdf("2404.06147", 1, opener=opener, resolver=PUBLIC_RESOLVER)

        self.assertEqual(result.content, PDF)
        self.assertEqual(result.source_url, "https://arxiv.org/pdf/2404.06147v1")
        self.assertEqual(len(result.content_sha256), 64)
        self.assertEqual(requests[0][0].full_url, result.source_url)
        self.assertEqual(requests[0][0].get_header("Accept"), "application/pdf")
        self.assertEqual(requests[0][0].get_header("Accept-encoding"), "identity")

    def test_rejects_cross_origin_and_wrong_path_redirects(self):
        for location in (
            "https://example.org/steal",
            "https://arxiv.org/abs/2404.06147v1",
            "http://arxiv.org/pdf/2404.06147v1",
            "https://user:secret@arxiv.org/pdf/2404.06147v1",
            "https://arxiv.org:bad/pdf/2404.06147v1",
            "https://arxiv.org:99999/pdf/2404.06147v1",
            "https://[broken/pdf/2404.06147v1",
        ):
            def opener(request, timeout, target=location):
                raise urllib.error.HTTPError(
                    request.full_url, 302, "Found", headers(Location=target), None,
                )

            with self.subTest(location=location), self.assertRaises(ArxivPdfFetchError):
                fetch_arxiv_pdf("2404.06147", 1, opener=opener, resolver=PUBLIC_RESOLVER)

    def test_allows_only_bounded_same_identity_redirects(self):
        calls = []

        def opener(request, timeout):
            calls.append(request.full_url)
            if len(calls) == 1:
                raise urllib.error.HTTPError(
                    request.full_url, 302, "Found",
                    headers(Location="/pdf/2404.06147v1.pdf"), None,
                )
            return FakeResponse(url="https://arxiv.org/pdf/2404.06147v1.pdf")

        self.assertEqual(fetch_arxiv_pdf(
            "2404.06147", 1, opener=opener, resolver=PUBLIC_RESOLVER,
        ).content, PDF)
        self.assertEqual(calls, [
            "https://arxiv.org/pdf/2404.06147v1",
            "https://arxiv.org/pdf/2404.06147v1.pdf",
        ])

    def test_rejects_bad_type_length_magic_and_stream_overflow(self):
        invalid = (
            FakeResponse(response_headers=headers(Content_Type="text/html", Content_Length=len(PDF))),
            FakeResponse(response_headers=headers(Content_Type="application/pdf", Content_Length="invalid")),
            FakeResponse(response_headers=headers(Content_Type="application/pdf", Content_Length=ARXIV_PDF_MAX_BYTES + 1)),
            FakeResponse(response_headers=headers(
                Content_Type="application/pdf", Content_Length=len(PDF), Content_Encoding="gzip",
            )),
            FakeResponse(response_headers=headers(Content_Type="application/pdf", Content_Length=len(PDF) + 1)),
            FakeResponse(body=b"not a pdf", response_headers=headers(Content_Type="application/pdf", Content_Length=9)),
        )
        for response in invalid:
            with self.subTest(headers=dict(response.headers)), self.assertRaises(ArxivPdfFetchError):
                fetch_arxiv_pdf(
                    "2404.06147", 1,
                    opener=lambda request, timeout, value=response: value,
                    resolver=PUBLIC_RESOLVER,
                )

        class OverflowResponse(FakeResponse):
            def __init__(self):
                super().__init__(response_headers=headers(Content_Type="application/pdf"))
                self.reads = 0

            def read(self, size=-1):
                self.reads += 1
                if self.reads == 1:
                    return b"%PDF-" + b"x" * 11
                if self.reads == 2:
                    return b"x"
                return b""

        with patch("arxiv_pdf_fetch.ARXIV_PDF_MAX_BYTES", 16), self.assertRaises(ArxivPdfFetchError) as caught:
            fetch_arxiv_pdf(
                "2404.06147", 1,
                opener=lambda request, timeout: OverflowResponse(),
                resolver=PUBLIC_RESOLVER,
            )
        self.assertEqual(caught.exception.status_code, 413)

    def test_rejects_private_or_malformed_dns_results_before_opening(self):
        for address in ("127.0.0.1", "10.0.0.1", "169.254.1.1", "::1", "::ffff:127.0.0.1"):
            opened = False

            def opener(request, timeout):
                nonlocal opened
                opened = True
                return FakeResponse()

            resolver = lambda host, port, type, value=address: [(2, 1, 6, "", (value, port))]
            with self.subTest(address=address), self.assertRaises(ArxivPdfFetchError):
                fetch_arxiv_pdf("2404.06147", 1, opener=opener, resolver=resolver)
            self.assertFalse(opened)

    def test_rejects_redirect_loops(self):
        def opener(request, timeout):
            raise urllib.error.HTTPError(
                request.full_url, 302, "Found",
                headers(Location="/pdf/2404.06147v1"), None,
            )

        with self.assertRaises(ArxivPdfFetchError):
            fetch_arxiv_pdf("2404.06147", 1, opener=opener, resolver=PUBLIC_RESOLVER)

    def test_total_deadline_bounds_a_trickling_response(self):
        class ManualClock:
            value = 0.0

            def __call__(self):
                return self.value

        clock = ManualClock()

        class SlowResponse(FakeResponse):
            def read(self, size=-1):
                clock.value += 46
                return super().read(size)

        with self.assertRaises(ArxivPdfFetchError) as caught:
            fetch_arxiv_pdf(
                "2404.06147", 1,
                opener=lambda request, timeout: SlowResponse(),
                resolver=PUBLIC_RESOLVER,
                clock=clock,
            )
        self.assertEqual(caught.exception.status_code, 504)


if __name__ == "__main__":
    unittest.main()
