import json
import os
import unittest
import urllib.error
from contextlib import nullcontext
from unittest.mock import patch

import document_transform_adapters as adapters
from document_transform_adapters import (
    DOCLING_IMPLEMENTATION_ID,
    DOCUMENT_TRANSFORM_IMPLEMENTATION_IDS,
    MARKITDOWN_IMPLEMENTATION_ID,
    PLAIN_TEXT_IMPLEMENTATION_ID,
    TransformAdapterContractError,
    configured_document_transform_engine_version,
    docling_form_fields,
    document_transform_adapter_fingerprint,
    document_transform_adapter_config,
    execute_document_transform_adapter,
    resolve_document_transform_adapter,
)


class _FakeSocket:
    def __init__(self):
        self.timeouts = []

    def settimeout(self, value):
        self.timeouts.append(value)


class _ReleasedFakeSocket(_FakeSocket):
    _closed = True

    def settimeout(self, value):
        super().settimeout(value)
        raise OSError(9, "Bad file descriptor")


class _JsonResponse:
    def __init__(self, payload, socket=None):
        self.encoded = json.dumps(payload).encode("utf-8")
        self.headers = {"Content-Length": str(len(self.encoded))}
        self.socket = socket or _FakeSocket()
        self.fp = type("ResponseBuffer", (), {
            "raw": type("ResponseRaw", (), {"_sock": self.socket})(),
        })()
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.closed = True

    def read1(self, maximum):
        value, self.encoded = self.encoded[:maximum], self.encoded[maximum:]
        return value


class _RawResponse(_JsonResponse):
    def __init__(self, encoded):
        self.encoded = encoded
        self.headers = {"Content-Length": str(len(encoded))}
        self.socket = _FakeSocket()
        self.fp = type("ResponseBuffer", (), {
            "raw": type("ResponseRaw", (), {"_sock": self.socket})(),
        })()
        self.closed = False


_DOCLING_TASK_ID = "11111111-2222-4333-8444-555555555555"


def _docling_async_responses(result_payload, *poll_statuses):
    statuses = poll_statuses or ("success",)
    return [
        _JsonResponse({"task_id": _DOCLING_TASK_ID, "task_status": "pending"}),
        *(
            _JsonResponse({"task_id": _DOCLING_TASK_ID, "task_status": status})
            for status in statuses
        ),
        *([_JsonResponse(result_payload)] if statuses[-1] == "success" else []),
    ]


class DocumentTransformAdapterTests(unittest.TestCase):
    def test_only_exact_builtin_implementation_ids_resolve(self):
        self.assertEqual(DOCUMENT_TRANSFORM_IMPLEMENTATION_IDS, {
            "builtin.docling.convert",
            "builtin.markitdown.convert",
            "builtin.plain-text.convert",
        })
        self.assertEqual(
            resolve_document_transform_adapter(DOCLING_IMPLEMENTATION_ID).plugin_id,
            "docling",
        )
        self.assertEqual(
            resolve_document_transform_adapter(DOCLING_IMPLEMENTATION_ID).plugin_version,
            "1.0.2",
        )
        self.assertEqual(
            resolve_document_transform_adapter(MARKITDOWN_IMPLEMENTATION_ID).plugin_version,
            "1.0.1",
        )
        for value in ("docling", "builtin.docling.convert-route", "BUILTIN.DOCLING.CONVERT", ""):
            with self.subTest(value=value), self.assertRaises(TransformAdapterContractError):
                resolve_document_transform_adapter(value)

    def test_docling_fields_are_fixed_and_format_aware(self):
        expected = {
            ("paper.pdf", "application/pdf"): "pdf",
            (
                "paper.docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ): "docx",
            ("paper.html", "text/html; charset=utf-8"): "html",
            ("paper.xhtml", "application/xhtml+xml"): "html",
        }
        for source, source_format in expected.items():
            with self.subTest(source=source):
                fields = docling_form_fields(*source)
                self.assertEqual(fields[0], ("from_formats", source_format))
                self.assertEqual([value for name, value in fields if name == "to_formats"], ["json", "md"])
                self.assertIn(("image_export_mode", "embedded"), fields)
                self.assertIn(("do_formula_enrichment", "false"), fields)
                self.assertNotIn(("do_formula_enrichment", "true"), fields)
        with self.assertRaises(TransformAdapterContractError):
            docling_form_fields("paper.docx", "application/pdf")
        with self.assertRaises(TransformAdapterContractError):
            docling_form_fields("archive.zip", "application/zip")

    def test_config_and_engine_version_are_server_owned(self):
        with patch.dict(os.environ, {"DOCLING_ENGINE_VERSION": "2.52.0"}, clear=False):
            self.assertEqual(
                configured_document_transform_engine_version(DOCLING_IMPLEMENTATION_ID),
                "2.52.0",
            )
            config = document_transform_adapter_config(
                DOCLING_IMPLEMENTATION_ID,
                "document-structure",
                filename="paper.docx",
                media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        self.assertEqual(config["pluginId"], "docling")
        self.assertEqual(config["configRevision"], "docling-json-markdown-embedded-images-v3")
        self.assertEqual(config["engineVersion"], "2.52.0")
        self.assertEqual(config["options"]["from_formats"], ["docx"])
        self.assertEqual(config["options"]["to_formats"], ["json", "md"])
        self.assertEqual(config["execution"], {
            "mode": "async", "maxWaitSeconds": 900, "pollIntervalSeconds": 2,
        })
        self.assertEqual(
            configured_document_transform_engine_version(PLAIN_TEXT_IMPLEMENTATION_ID),
            "unicode-15",
        )
        self.assertEqual(
            configured_document_transform_engine_version(MARKITDOWN_IMPLEMENTATION_ID),
            "0.1.8",
        )
        with patch.dict(os.environ, {"DOCLING_ENGINE_VERSION": "2.52.0"}, clear=False):
            first = document_transform_adapter_fingerprint()
            self.assertEqual(first, document_transform_adapter_fingerprint())
        with patch.dict(os.environ, {"DOCLING_ENGINE_VERSION": "2.53.0"}, clear=False):
            self.assertNotEqual(first, document_transform_adapter_fingerprint())

    def test_docling_executes_with_fixed_route_credentials_and_docx_fields(self):
        payload = {
            "status": "success",
            "errors": [],
            "engine_version": "2.52.0",
            "document": {
                "pages": [],
                "blocks": [{"kind": "paragraph", "text": "Converted"}],
                "md_content": "# Converted",
            },
        }
        responses = iter(_docling_async_responses(payload, "started", "success"))
        captured = []

        def open_request(request, timeout):
            captured.append((request, timeout))
            return next(responses)

        with (
            patch.dict(os.environ, {
                "DOCLING_API_INTERNAL": "https://docling.internal:5001",
                "DOCLING_API_KEY": "server-secret",
                "GALAXY_DEPLOY_DOCLING_API_KEY": "deployment-secret",
                "DOCLING_ENGINE_VERSION": "2.52.0",
            }, clear=False),
            patch.object(adapters._TRANSFORM_OPENER, "open", side_effect=open_request),
            patch.object(adapters.time, "sleep") as sleep,
        ):
            result = execute_document_transform_adapter(
                DOCLING_IMPLEMENTATION_ID,
                filename="paper.docx",
                media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                content=b"docx-bytes",
            )

        self.assertEqual(result.status, "success")
        self.assertIsNone(result.diagnostic_code)
        self.assertEqual(result.markdown, "# Converted")
        self.assertEqual(result.structure["blocks"][0]["text"], "Converted")
        self.assertEqual(result.as_dict()["schemaId"], "gb.document-transform-adapter-result.v1")
        request, timeout = captured[0]
        self.assertEqual(request.full_url, "https://docling.internal:5001/v1/convert/file/async")
        self.assertEqual(timeout, 120)
        self.assertEqual(request.get_header("X-api-key"), "server-secret")
        self.assertIn(b'name="files"; filename="paper.docx"', request.data)
        self.assertIn(b'name="from_formats"\r\n\r\ndocx\r\n', request.data)
        self.assertNotIn(b'name="from_formats"\r\n\r\npdf\r\n', request.data)
        self.assertEqual(
            [item[0].full_url for item in captured[1:]],
            [
                f"https://docling.internal:5001/v1/status/poll/{_DOCLING_TASK_ID}",
                f"https://docling.internal:5001/v1/status/poll/{_DOCLING_TASK_ID}",
                f"https://docling.internal:5001/v1/result/{_DOCLING_TASK_ID}",
            ],
        )
        self.assertTrue(all(item[0].get_method() == "GET" for item in captured[1:]))
        self.assertTrue(all(item[0].get_header("X-api-key") == "server-secret" for item in captured))
        sleep.assert_called_once_with(2)

    def test_docling_uses_deployment_key_when_service_key_is_missing_or_blank(self):
        payload = {
            "status": "success",
            "errors": [],
            "engine_version": "2.52.0",
            "document": {
                "pages": [],
                "blocks": [{"kind": "paragraph", "text": "Converted"}],
                "md_content": "# Converted",
            },
        }
        for service_token in (None, "   "):
            environment = {
                "DOCLING_API_INTERNAL": "https://docling.internal:5001",
                "GALAXY_DEPLOY_DOCLING_API_KEY": "deployment-secret",
                "DOCLING_ENGINE_VERSION": "2.52.0",
            }
            if service_token is not None:
                environment["DOCLING_API_KEY"] = service_token
            responses = iter(_docling_async_responses(payload))
            captured = []

            def open_request(request, timeout):
                captured.append((request, timeout))
                return next(responses)

            with (
                self.subTest(service_token=service_token),
                patch.dict(os.environ, environment, clear=True),
                patch.object(adapters._TRANSFORM_OPENER, "open", side_effect=open_request),
            ):
                result = execute_document_transform_adapter(
                    DOCLING_IMPLEMENTATION_ID,
                    filename="paper.pdf",
                    media_type="application/pdf",
                    content=b"%PDF",
                )

            self.assertEqual(result.status, "success")
            self.assertTrue(captured)
            self.assertTrue(
                all(
                    item[0].get_header("X-api-key") == "deployment-secret"
                    for item in captured
                ),
            )

    def test_docling_rejects_unconfigured_mismatch_and_malformed_payloads(self):
        with patch.dict(os.environ, {"DOCLING_ENGINE_VERSION": ""}, clear=False):
            unconfigured = execute_document_transform_adapter(
                DOCLING_IMPLEMENTATION_ID,
                filename="paper.pdf",
                media_type="application/pdf",
                content=b"%PDF",
            )
        self.assertEqual(unconfigured.status, "failed")
        self.assertEqual(unconfigured.diagnostic_code, "docling.engine_version_not_configured")

        cases = (
            ({"status": "success", "errors": [], "engine_version": "other", "document": {}},
             "docling.engine_version_mismatch"),
            ({"status": "failure", "errors": [], "document": {}}, "docling.invalid_response"),
        )
        for index, (payload, diagnostic) in enumerate(cases):
            with (
                self.subTest(index=index),
                patch.dict(os.environ, {
                    "DOCLING_API_INTERNAL": "https://docling.internal",
                    "DOCLING_API_KEY": "server-secret",
                    "DOCLING_ENGINE_VERSION": "2.52.0",
                }, clear=False),
                patch.object(
                    adapters._TRANSFORM_OPENER,
                    "open",
                    side_effect=_docling_async_responses(payload),
                ),
            ):
                result = execute_document_transform_adapter(
                    DOCLING_IMPLEMENTATION_ID,
                    filename="paper.pdf",
                    media_type="application/pdf",
                    content=b"%PDF",
                )
            self.assertEqual(result.status, "failed")
            self.assertEqual(result.diagnostic_code, diagnostic)
            self.assertIsNone(result.structure)
            self.assertIsNone(result.markdown)

    def test_docling_preserves_markdown_and_reports_invalid_structure(self):
        payload = {
            "status": "success",
            "errors": [],
            "engine_version": "2.52.0",
            "document": {
                "json_content": "not-json",
                "md_content": "![Diagram](data:image/png;base64,iVBORw==)",
            },
        }
        with (
            patch.dict(os.environ, {
                "DOCLING_API_INTERNAL": "https://docling.internal",
                "DOCLING_API_KEY": "server-secret",
                "DOCLING_ENGINE_VERSION": "2.52.0",
            }, clear=False),
            patch.object(
                adapters._TRANSFORM_OPENER,
                "open",
                side_effect=_docling_async_responses(payload),
            ),
        ):
            result = execute_document_transform_adapter(
                DOCLING_IMPLEMENTATION_ID,
                filename="paper.pdf",
                media_type="application/pdf",
                content=b"%PDF",
            )

        self.assertEqual(result.status, "partial")
        self.assertEqual(result.diagnostic_code, "docling.structure_invalid")
        self.assertIsNone(result.structure)
        self.assertIn("data:image/png;base64", result.markdown)

    def test_markitdown_uses_fixed_provider_contract_and_validates_envelope(self):
        response = _JsonResponse({
            "markdown": "# Exact",
            "engine_version": "0.1.8",
        })
        captured = []
        with (
            patch.dict(os.environ, {
                "MARKITDOWN_API_INTERNAL": "https://markitdown.internal",
                "MARKITDOWN_PROXY_TOKEN": "server-proxy-secret",
            }, clear=False),
            patch.object(
                adapters._TRANSFORM_OPENER,
                "open",
                side_effect=lambda request, timeout: captured.append((request, timeout)) or response,
            ),
        ):
            result = execute_document_transform_adapter(
                MARKITDOWN_IMPLEMENTATION_ID,
                filename="paper.pdf",
                media_type="application/pdf",
                content=b"%PDF",
            )
        self.assertEqual(result.status, "success")
        self.assertEqual(result.markdown, "# Exact")
        self.assertEqual(result.engine_version, "0.1.8")
        request, _timeout = captured[0]
        self.assertEqual(request.full_url, "https://markitdown.internal/convert")
        self.assertEqual(request.get_header("X-gb-proxy-token"), "server-proxy-secret")
        self.assertIn(b'name="file"; filename="paper.pdf"', request.data)

        with (
            patch.dict(os.environ, {
                "MARKITDOWN_API_INTERNAL": "https://markitdown.internal",
                "MARKITDOWN_PROXY_TOKEN": "server-proxy-secret",
            }, clear=False),
            patch.object(adapters._TRANSFORM_OPENER, "open", return_value=_JsonResponse({"markdown": "x"})),
        ):
            malformed = execute_document_transform_adapter(
                MARKITDOWN_IMPLEMENTATION_ID,
                filename="paper.pdf",
                media_type="application/pdf",
                content=b"%PDF",
            )
        self.assertEqual(malformed.status, "failed")
        self.assertEqual(malformed.diagnostic_code, "markitdown.invalid_response")

        with patch.object(adapters._TRANSFORM_OPENER, "open") as provider:
            mismatch = execute_document_transform_adapter(
                MARKITDOWN_IMPLEMENTATION_ID,
                filename="paper.docx",
                media_type="application/pdf",
                content=b"%PDF",
            )
        self.assertEqual(mismatch.status, "failed")
        self.assertEqual(mismatch.diagnostic_code, "markitdown.unsupported")
        provider.assert_not_called()

    def test_markitdown_reads_buffered_response_after_http_socket_release(self):
        response = _JsonResponse({
            "markdown": "# Buffered",
            "engine_version": "0.1.8",
        }, socket=_ReleasedFakeSocket())
        with (
            patch.dict(os.environ, {
                "MARKITDOWN_API_INTERNAL": "https://markitdown.internal",
                "MARKITDOWN_PROXY_TOKEN": "server-proxy-secret",
            }, clear=False),
            patch.object(adapters._TRANSFORM_OPENER, "open", return_value=response),
        ):
            result = execute_document_transform_adapter(
                MARKITDOWN_IMPLEMENTATION_ID,
                filename="paper.pdf",
                media_type="application/pdf",
                content=b"%PDF",
            )

        self.assertEqual(result.status, "success")
        self.assertEqual(result.markdown, "# Buffered")
        self.assertTrue(response.socket.timeouts)

    def test_transport_redirect_timeout_and_malformed_json_fail_closed(self):
        redirect = urllib.error.HTTPError(
            "https://docling.internal/v1/convert/file/async",
            302,
            "Found",
            {"Location": "https://attacker.invalid/collect"},
            None,
        )
        cases = (
            (redirect, "docling.redirected"),
            (urllib.error.HTTPError(
                "https://docling.internal/v1/convert/file/async", 504,
                "Gateway Timeout", {}, None,
            ), "docling.timeout"),
            (TimeoutError("deadline"), "docling.timeout"),
            (urllib.error.URLError(TimeoutError("connect timed out")), "docling.timeout"),
        )
        for error, diagnostic in cases:
            with (
                self.subTest(diagnostic=diagnostic),
                patch.dict(os.environ, {
                    "DOCLING_API_INTERNAL": "https://docling.internal",
                    "DOCLING_API_KEY": "server-secret",
                    "DOCLING_ENGINE_VERSION": "2.52.0",
                }, clear=False),
                patch.object(adapters._TRANSFORM_OPENER, "open", side_effect=error) as opened,
            ):
                result = execute_document_transform_adapter(
                    DOCLING_IMPLEMENTATION_ID,
                    filename="paper.pdf",
                    media_type="application/pdf",
                    content=b"%PDF",
                )
            self.assertEqual(result.status, "failed")
            self.assertEqual(result.diagnostic_code, diagnostic)
            self.assertEqual(opened.call_count, 1)

        malformed_response = _RawResponse(b"not-json")
        with (
            patch.dict(os.environ, {
                "DOCLING_API_INTERNAL": "https://docling.internal",
                "DOCLING_API_KEY": "server-secret",
                "DOCLING_ENGINE_VERSION": "2.52.0",
            }, clear=False),
            patch.object(adapters._TRANSFORM_OPENER, "open", return_value=malformed_response),
        ):
            malformed = execute_document_transform_adapter(
                DOCLING_IMPLEMENTATION_ID,
                filename="paper.pdf",
                media_type="application/pdf",
                content=b"%PDF",
            )
        self.assertEqual(malformed.status, "failed")
        self.assertEqual(malformed.diagnostic_code, "docling.invalid_response")
        self.assertTrue(malformed_response.closed)

    def test_docling_async_failure_timeout_and_task_identity_fail_closed(self):
        environment = {
            "DOCLING_API_INTERNAL": "https://docling.internal",
            "DOCLING_API_KEY": "server-secret",
            "DOCLING_ENGINE_VERSION": "2.52.0",
        }
        cases = (
            (
                _docling_async_responses({}, "failure"),
                {},
                "docling.failed",
                2,
            ),
            (
                [_JsonResponse({"task_id": _DOCLING_TASK_ID, "task_status": "pending"})],
                {"DOCLING_ASYNC_TIMEOUT_SECONDS": 0},
                "docling.timeout",
                1,
            ),
            (
                [
                    _JsonResponse({"task_id": _DOCLING_TASK_ID, "task_status": "pending"}),
                    _JsonResponse({
                        "task_id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                        "task_status": "success",
                    }),
                ],
                {},
                "docling.invalid_response",
                2,
            ),
        )
        for responses, constants, diagnostic, expected_calls in cases:
            constant_patch = patch.multiple(adapters, **constants) if constants else nullcontext()
            with (
                self.subTest(diagnostic=diagnostic),
                patch.dict(os.environ, environment, clear=False),
                patch.object(adapters._TRANSFORM_OPENER, "open", side_effect=responses) as opened,
                constant_patch,
            ):
                result = execute_document_transform_adapter(
                    DOCLING_IMPLEMENTATION_ID,
                    filename="paper.pdf",
                    media_type="application/pdf",
                    content=b"%PDF",
                )
            self.assertEqual(result.status, "failed")
            self.assertEqual(result.diagnostic_code, diagnostic)
            self.assertEqual(opened.call_count, expected_calls)

    def test_callers_cannot_override_endpoint_or_credentials(self):
        for forbidden in (
            {"endpoint": "https://attacker.invalid/collect"},
            {"token": "caller-secret"},
            {"credentials": {"X-API-Key": "caller-secret"}},
        ):
            with self.subTest(forbidden=forbidden), self.assertRaises(TypeError):
                execute_document_transform_adapter(
                    DOCLING_IMPLEMENTATION_ID,
                    filename="paper.pdf",
                    media_type="application/pdf",
                    content=b"%PDF",
                    **forbidden,
                )

    def test_plain_text_is_local_utf8_only_and_bounded(self):
        result = execute_document_transform_adapter(
            PLAIN_TEXT_IMPLEMENTATION_ID,
            filename="notes.md",
            media_type="text/markdown; charset=utf-8",
            content=b"# Notes",
        )
        self.assertEqual(result.status, "success")
        self.assertEqual(result.markdown, "# Notes")
        self.assertEqual(result.engine_version, "unicode-15")

        invalid = execute_document_transform_adapter(
            PLAIN_TEXT_IMPLEMENTATION_ID,
            filename="notes.md",
            media_type="text/markdown",
            content=b"\xff",
        )
        self.assertEqual(invalid.status, "failed")
        self.assertEqual(invalid.diagnostic_code, "plain_text.invalid_utf8")

    def test_transport_output_bound_becomes_exact_failed_envelope(self):
        response = _JsonResponse({"markdown": "too long", "engine_version": "1.0"})
        response.headers = {}
        with (
            patch.dict(os.environ, {
                "MARKITDOWN_API_INTERNAL": "https://markitdown.internal",
                "MARKITDOWN_PROXY_TOKEN": "server-proxy-secret",
            }, clear=False),
            patch.object(adapters, "MAX_TRANSFORM_OUTPUT_BYTES", 8),
            patch.object(adapters._TRANSFORM_OPENER, "open", return_value=response),
        ):
            result = execute_document_transform_adapter(
                MARKITDOWN_IMPLEMENTATION_ID,
                filename="paper.pdf",
                media_type="application/pdf",
                content=b"%PDF",
            )
        self.assertEqual(result.status, "failed")
        self.assertEqual(result.diagnostic_code, "markitdown.output_too_large")
        self.assertIsNone(result.markdown)


if __name__ == "__main__":
    unittest.main()
