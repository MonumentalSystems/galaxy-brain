"""Race-resistant exact reads for tenant-authorized filesystem datasources.

POSIX walks from a held configured tenant-root descriptor with ``openat``
semantics and ``O_NOFOLLOW`` on every connection and item segment. Windows
holds the configured tenant-root and connection-root handles, rejects reparse
points, and validates opened identities before reading the same item handle.
"""

from __future__ import annotations

import errno
import mimetypes
import os
import stat
from dataclasses import dataclass
from pathlib import Path

from tenant_filesystem import AuthorizedTenantRoot


MAX_DATASOURCE_ENUMERATION_ITEMS = 10_000
MAX_DATASOURCE_ENUMERATION_ENTRIES = 50_000
MAX_DATASOURCE_ENUMERATION_DEPTH = 64
SKIP_DIRS = frozenset({".git", ".next", "node_modules", "__pycache__", ".venv", "venv"})

TEXT_MIME_BY_EXTENSION = {
    ".c": "text/plain",
    ".cpp": "text/plain",
    ".css": "text/css",
    ".csv": "text/csv",
    ".go": "text/plain",
    ".h": "text/plain",
    ".htm": "text/html",
    ".html": "text/html",
    ".java": "text/plain",
    ".js": "text/javascript",
    ".json": "application/json",
    ".jsx": "text/javascript",
    ".log": "text/plain",
    ".markdown": "text/markdown",
    ".md": "text/markdown",
    ".mdx": "text/markdown",
    ".php": "text/plain",
    ".py": "text/x-python",
    ".rb": "text/plain",
    ".rs": "text/plain",
    ".sh": "text/x-shellscript",
    ".sql": "text/plain",
    ".toml": "text/plain",
    ".ts": "text/plain",
    ".tsx": "text/plain",
    ".txt": "text/plain",
    ".xml": "application/xml",
    ".yaml": "text/plain",
    ".yml": "text/plain",
}


class DatasourceFileError(Exception):
    """Base class for safe, caller-mapped datasource file failures."""


class DatasourceFileNotFound(DatasourceFileError):
    pass


class DatasourceFileRejected(DatasourceFileError):
    pass


class DatasourceFileTooLarge(DatasourceFileError):
    pass


@dataclass(frozen=True)
class AuthorizedDatasourceFile:
    content: bytes
    filename: str
    media_type: str
    modified_at: float


@dataclass(frozen=True)
class AuthorizedDatasourceEntry:
    item_id: str
    filename: str
    media_type: str
    size: int
    modified_at: float


@dataclass(frozen=True)
class AuthorizedDatasourceListing:
    entries: tuple[AuthorizedDatasourceEntry, ...]
    truncated: bool
    visited_entries: int


def datasource_media_type(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix in TEXT_MIME_BY_EXTENSION:
        return TEXT_MIME_BY_EXTENSION[suffix]
    if suffix == ".pdf":
        return "application/pdf"
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "application/octet-stream"


def _item_parts(item_id: str) -> tuple[str, ...]:
    if not isinstance(item_id, str) or not item_id or "\x00" in item_id:
        raise DatasourceFileRejected("Invalid datasource item identity")
    normalized = item_id.replace("\\", "/")
    if normalized.startswith("/"):
        raise DatasourceFileRejected("Absolute datasource item paths are forbidden")
    parts = tuple(normalized.split("/"))
    if any(part in {"", ".", ".."} for part in parts):
        raise DatasourceFileRejected("Invalid datasource item path segment")
    if os.name == "nt" and any(":" in part for part in parts):
        raise DatasourceFileRejected("Windows alternate data streams are forbidden")
    return parts


def _read_fd(fd: int, maximum_bytes: int) -> tuple[bytes, float]:
    metadata = os.fstat(fd)
    if not stat.S_ISREG(metadata.st_mode):
        raise DatasourceFileRejected("Datasource item is not a regular file")
    if metadata.st_size < 1:
        raise DatasourceFileRejected("Datasource item is empty")
    if metadata.st_size > maximum_bytes:
        raise DatasourceFileTooLarge("Datasource item exceeds the import limit")

    chunks: list[bytes] = []
    remaining = maximum_bytes + 1
    while remaining > 0:
        chunk = os.read(fd, min(1_048_576, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    content = b"".join(chunks)
    if not content:
        raise DatasourceFileRejected("Datasource item is empty")
    if len(content) > maximum_bytes:
        raise DatasourceFileTooLarge("Datasource item exceeds the import limit")
    return content, metadata.st_mtime


def _validate_content(filename: str, content: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    media_type = datasource_media_type(filename)
    if suffix in TEXT_MIME_BY_EXTENSION:
        try:
            content.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise DatasourceFileRejected("Text datasource item is not valid UTF-8") from error
        if b"\x00" in content:
            raise DatasourceFileRejected("Text datasource item contains binary null bytes")
    elif suffix == ".pdf":
        if not content.startswith(b"%PDF-"):
            raise DatasourceFileRejected("PDF datasource item has an invalid signature")
    else:
        raise DatasourceFileRejected("Datasource item type is outside the durable import allowlist")
    return media_type


def _open_posix_directory_chain(
    base_fd: int,
    parts: tuple[str, ...],
    directory_flags: int,
) -> int:
    current_fd = os.dup(base_fd)
    try:
        for part in parts:
            next_fd = os.open(part, directory_flags, dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except Exception:
        os.close(current_fd)
        raise


def _bounded_names(iterator, state: dict[str, int | bool]) -> list[str]:
    names: list[str] = []
    for entry in iterator:
        if int(state["visited"]) >= MAX_DATASOURCE_ENUMERATION_ENTRIES:
            state["truncated"] = True
            break
        state["visited"] = int(state["visited"]) + 1
        names.append(entry.name)
    names.sort(key=lambda value: (value.casefold(), value))
    return names


def _bounded_name_types(
    iterator,
    state: dict[str, int | bool],
) -> list[tuple[str, bool]]:
    entries: list[tuple[str, bool]] = []
    for entry in iterator:
        if int(state["visited"]) >= MAX_DATASOURCE_ENUMERATION_ENTRIES:
            state["truncated"] = True
            break
        state["visited"] = int(state["visited"]) + 1
        try:
            is_directory = entry.is_dir(follow_symlinks=False)
        except OSError:
            is_directory = False
        entries.append((entry.name, is_directory))
    entries.sort(key=lambda value: (value[0].casefold(), value[0]))
    return entries


def _enumerate_posix(
    binding: AuthorizedTenantRoot,
    maximum_items: int,
) -> AuthorizedDatasourceListing:
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
    file_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
    configured_root_fd = -1
    connection_root_fd = -1
    entries: list[AuthorizedDatasourceEntry] = []
    state: dict[str, int | bool] = {"visited": 0, "truncated": False}

    def walk(directory_fd: int, prefix: tuple[str, ...], depth: int) -> None:
        if state["truncated"]:
            return
        if depth > MAX_DATASOURCE_ENUMERATION_DEPTH:
            state["truncated"] = True
            return
        try:
            with os.scandir(directory_fd) as iterator:
                names = _bounded_names(iterator, state)
        except OSError as error:
            raise DatasourceFileNotFound("Datasource directory could not be enumerated safely") from error
        for name in names:
            if state["truncated"]:
                return
            if name.startswith(".") or name in SKIP_DIRS:
                continue
            try:
                child_directory_fd = os.open(name, directory_flags, dir_fd=directory_fd)
            except OSError:
                child_directory_fd = -1
            if child_directory_fd >= 0:
                try:
                    walk(child_directory_fd, (*prefix, name), depth + 1)
                finally:
                    os.close(child_directory_fd)
                continue
            try:
                file_fd = os.open(name, file_flags, dir_fd=directory_fd)
            except OSError:
                continue
            try:
                metadata = os.fstat(file_fd)
                if not stat.S_ISREG(metadata.st_mode):
                    continue
                if len(entries) >= maximum_items:
                    state["truncated"] = True
                    return
                item_id = "/".join((*prefix, name))
                entries.append(AuthorizedDatasourceEntry(
                    item_id=item_id,
                    filename=name,
                    media_type=datasource_media_type(name),
                    size=metadata.st_size,
                    modified_at=metadata.st_mtime,
                ))
            finally:
                os.close(file_fd)

    try:
        configured_root_fd = os.open(binding.configured_root, directory_flags)
        connection_root_fd = _open_posix_directory_chain(
            configured_root_fd,
            binding.relative_parts,
            directory_flags,
        )
        walk(connection_root_fd, (), 0)
    except DatasourceFileError:
        raise
    except OSError as error:
        raise DatasourceFileNotFound("Datasource root could not be enumerated safely") from error
    finally:
        if connection_root_fd >= 0:
            os.close(connection_root_fd)
        if configured_root_fd >= 0:
            os.close(configured_root_fd)
    entries.sort(key=lambda item: (item.item_id.casefold(), item.filename))
    return AuthorizedDatasourceListing(
        entries=tuple(entries),
        truncated=bool(state["truncated"]),
        visited_entries=int(state["visited"]),
    )


def _read_posix(
    binding: AuthorizedTenantRoot,
    parts: tuple[str, ...],
    maximum_bytes: int,
) -> tuple[bytes, float]:
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
    configured_root_fd = -1
    connection_root_fd = -1
    item_parent_fd = -1
    try:
        configured_root_fd = os.open(binding.configured_root, directory_flags)
        connection_root_fd = _open_posix_directory_chain(
            configured_root_fd,
            binding.relative_parts,
            directory_flags,
        )
        item_parent_fd = _open_posix_directory_chain(
            connection_root_fd,
            parts[:-1],
            directory_flags,
        )
        file_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
        try:
            file_fd = os.open(parts[-1], file_flags, dir_fd=item_parent_fd)
        except OSError as error:
            if error.errno == errno.ELOOP:
                raise DatasourceFileRejected("Datasource item may not be a symbolic link") from error
            raise
        try:
            return _read_fd(file_fd, maximum_bytes)
        finally:
            os.close(file_fd)
    except DatasourceFileError:
        raise
    except OSError as error:
        raise DatasourceFileNotFound("Datasource item could not be opened safely") from error
    finally:
        for descriptor in (item_parent_fd, connection_root_fd, configured_root_fd):
            if descriptor >= 0:
                os.close(descriptor)


if os.name == "nt":
    import ctypes
    import msvcrt
    from ctypes import wintypes

    _GENERIC_READ = 0x80000000
    _FILE_READ_ATTRIBUTES = 0x0080
    _FILE_SHARE_ALL = 0x00000001 | 0x00000002 | 0x00000004
    _OPEN_EXISTING = 3
    _FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
    _FILE_ATTRIBUTE_DIRECTORY = 0x00000010
    _FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    _FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
    _FILE_FLAG_SEQUENTIAL_SCAN = 0x08000000
    _FILE_ATTRIBUTE_TAG_INFO_CLASS = 9
    _FILE_ID_INFO_CLASS = 18
    _INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class _FileAttributeTagInfo(ctypes.Structure):
        _fields_ = [("FileAttributes", wintypes.DWORD), ("ReparseTag", wintypes.DWORD)]

    class _FileIdInfo(ctypes.Structure):
        _fields_ = [
            ("VolumeSerialNumber", ctypes.c_ulonglong),
            ("FileId", ctypes.c_ubyte * 16),
        ]

    _kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    ]
    _kernel32.CreateFileW.restype = wintypes.HANDLE
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel32.CloseHandle.restype = wintypes.BOOL
    _kernel32.GetFileInformationByHandleEx.argtypes = [
        wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
    ]
    _kernel32.GetFileInformationByHandleEx.restype = wintypes.BOOL
    _kernel32.GetFinalPathNameByHandleW.argtypes = [
        wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD,
    ]
    _kernel32.GetFinalPathNameByHandleW.restype = wintypes.DWORD


def _windows_open_handle(path: str, *, directory: bool) -> int:
    access = _FILE_READ_ATTRIBUTES if directory else _GENERIC_READ
    flags = _FILE_FLAG_OPEN_REPARSE_POINT
    flags |= _FILE_FLAG_BACKUP_SEMANTICS if directory else _FILE_FLAG_SEQUENTIAL_SCAN
    handle = _kernel32.CreateFileW(
        path,
        access,
        _FILE_SHARE_ALL,
        None,
        _OPEN_EXISTING,
        flags,
        None,
    )
    if handle == _INVALID_HANDLE_VALUE:
        raise ctypes.WinError(ctypes.get_last_error())
    return handle


def _windows_file_attributes(handle: int) -> int:
    info = _FileAttributeTagInfo()
    if not _kernel32.GetFileInformationByHandleEx(
        handle,
        _FILE_ATTRIBUTE_TAG_INFO_CLASS,
        ctypes.byref(info),
        ctypes.sizeof(info),
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    return info.FileAttributes


def _windows_is_reparse_point(handle: int) -> bool:
    return bool(_windows_file_attributes(handle) & _FILE_ATTRIBUTE_REPARSE_POINT)


def _windows_file_identity(handle: int) -> tuple[int, bytes]:
    info = _FileIdInfo()
    if not _kernel32.GetFileInformationByHandleEx(
        handle,
        _FILE_ID_INFO_CLASS,
        ctypes.byref(info),
        ctypes.sizeof(info),
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    return info.VolumeSerialNumber, bytes(info.FileId)


def _windows_final_path(handle: int) -> str:
    length = _kernel32.GetFinalPathNameByHandleW(handle, None, 0, 0)
    if not length:
        raise ctypes.WinError(ctypes.get_last_error())
    buffer = ctypes.create_unicode_buffer(length + 1)
    copied = _kernel32.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 0)
    if not copied or copied >= len(buffer):
        raise ctypes.WinError(ctypes.get_last_error())
    value = buffer.value
    if value.startswith("\\\\?\\UNC\\"):
        value = "\\\\" + value[8:]
    elif value.startswith("\\\\?\\"):
        value = value[4:]
    return os.path.normcase(os.path.normpath(value))


def _windows_normal_path(path: str) -> str:
    return os.path.normcase(os.path.normpath(path))


def _windows_require_contained_path(path: str, root: str, *, allow_root: bool) -> None:
    try:
        if os.path.commonpath([path, root]) != root or (not allow_root and path == root):
            raise DatasourceFileRejected("Opened datasource path escaped its authorized root")
    except ValueError as error:
        raise DatasourceFileRejected("Opened datasource path escaped its authorized root") from error


def _windows_open_checked_directory(
    path: str,
    *,
    expected_path: str,
    held_authority_path: str,
) -> int:
    handle = _windows_open_handle(path, directory=True)
    try:
        attributes = _windows_file_attributes(handle)
        if attributes & _FILE_ATTRIBUTE_REPARSE_POINT:
            raise DatasourceFileRejected("Datasource directory may not be a reparse point")
        if not attributes & _FILE_ATTRIBUTE_DIRECTORY:
            raise DatasourceFileRejected("Datasource directory component is not a directory")
        opened_path = _windows_final_path(handle)
        _windows_require_contained_path(opened_path, held_authority_path, allow_root=True)
        if opened_path != _windows_normal_path(expected_path):
            raise DatasourceFileRejected("Datasource directory identity changed while opening")
        return handle
    except Exception:
        _kernel32.CloseHandle(handle)
        raise


def _read_windows(
    binding: AuthorizedTenantRoot,
    parts: tuple[str, ...],
    maximum_bytes: int,
) -> tuple[bytes, float]:
    configured_root_handle = None
    connection_root_handle = None
    file_handle = None
    verification_configured_handle = None
    verification_connection_handle = None
    file_fd = -1
    try:
        configured_root_handle = _windows_open_handle(binding.configured_root, directory=True)
        if _windows_is_reparse_point(configured_root_handle):
            raise DatasourceFileRejected("Configured tenant root may not be a reparse point")
        held_configured_path = _windows_final_path(configured_root_handle)
        if held_configured_path != _windows_normal_path(binding.configured_root):
            raise DatasourceFileRejected("Configured tenant root identity changed while opening")
        held_configured_identity = _windows_file_identity(configured_root_handle)

        if not binding.relative_parts:
            connection_root_handle = _windows_open_checked_directory(
                binding.connection_root,
                expected_path=binding.connection_root,
                held_authority_path=held_configured_path,
            )
        else:
            for index in range(1, len(binding.relative_parts) + 1):
                expected = os.path.join(
                    binding.configured_root,
                    *binding.relative_parts[:index],
                )
                component_handle = _windows_open_checked_directory(
                    expected,
                    expected_path=expected,
                    held_authority_path=held_configured_path,
                )
                if index == len(binding.relative_parts):
                    connection_root_handle = component_handle
                else:
                    _kernel32.CloseHandle(component_handle)
        if connection_root_handle is None:
            raise DatasourceFileRejected("Datasource connection root could not be anchored")
        held_connection_path = _windows_final_path(connection_root_handle)
        if held_connection_path != _windows_normal_path(binding.connection_root):
            raise DatasourceFileRejected("Datasource connection root does not match its authorized target")
        held_connection_identity = _windows_file_identity(connection_root_handle)

        for index in range(1, len(parts)):
            expected_parent = os.path.join(binding.connection_root, *parts[:index])
            parent_handle = _windows_open_checked_directory(
                expected_parent,
                expected_path=expected_parent,
                held_authority_path=held_connection_path,
            )
            _kernel32.CloseHandle(parent_handle)

        candidate = os.path.join(binding.connection_root, *parts)
        file_handle = _windows_open_handle(candidate, directory=False)
        if _windows_is_reparse_point(file_handle):
            raise DatasourceFileRejected("Datasource item may not be a reparse point")
        opened_path = _windows_final_path(file_handle)
        _windows_require_contained_path(opened_path, held_connection_path, allow_root=False)

        verification_configured_handle = _windows_open_handle(binding.configured_root, directory=True)
        if (
            _windows_is_reparse_point(verification_configured_handle)
            or _windows_file_identity(verification_configured_handle) != held_configured_identity
        ):
            raise DatasourceFileRejected("Configured tenant root changed while opening the item")
        verification_connection_handle = _windows_open_handle(binding.connection_root, directory=True)
        if (
            _windows_is_reparse_point(verification_connection_handle)
            or _windows_file_identity(verification_connection_handle) != held_connection_identity
        ):
            raise DatasourceFileRejected("Datasource connection root changed while opening the item")

        file_fd = msvcrt.open_osfhandle(
            file_handle,
            os.O_RDONLY | getattr(os, "O_BINARY", 0),
        )
        file_handle = None  # descriptor now owns the Win32 handle
        return _read_fd(file_fd, maximum_bytes)
    except DatasourceFileError:
        raise
    except OSError as error:
        raise DatasourceFileNotFound("Datasource item could not be opened safely") from error
    finally:
        if file_fd >= 0:
            os.close(file_fd)
        elif file_handle is not None:
            _kernel32.CloseHandle(file_handle)
        for handle in (
            verification_connection_handle,
            verification_configured_handle,
            connection_root_handle,
            configured_root_handle,
        ):
            if handle is not None:
                _kernel32.CloseHandle(handle)


def _windows_file_metadata(
    path: str,
    *,
    expected_path: str,
    held_authority_path: str,
) -> os.stat_result:
    handle = None
    file_fd = -1
    try:
        handle = _windows_open_handle(path, directory=False)
        attributes = _windows_file_attributes(handle)
        if attributes & _FILE_ATTRIBUTE_REPARSE_POINT:
            raise DatasourceFileRejected("Datasource item may not be a reparse point")
        if attributes & _FILE_ATTRIBUTE_DIRECTORY:
            raise DatasourceFileRejected("Datasource item is not a regular file")
        opened_path = _windows_final_path(handle)
        _windows_require_contained_path(opened_path, held_authority_path, allow_root=False)
        if opened_path != _windows_normal_path(expected_path):
            raise DatasourceFileRejected("Datasource item identity changed while enumerating")
        file_fd = msvcrt.open_osfhandle(
            handle,
            os.O_RDONLY | getattr(os, "O_BINARY", 0),
        )
        handle = None
        metadata = os.fstat(file_fd)
        if not stat.S_ISREG(metadata.st_mode):
            raise DatasourceFileRejected("Datasource item is not a regular file")
        return metadata
    finally:
        if file_fd >= 0:
            os.close(file_fd)
        elif handle is not None:
            _kernel32.CloseHandle(handle)


def _enumerate_windows(
    binding: AuthorizedTenantRoot,
    maximum_items: int,
) -> AuthorizedDatasourceListing:
    configured_root_handle = None
    connection_root_handle = None
    verification_configured_handle = None
    verification_connection_handle = None
    entries: list[AuthorizedDatasourceEntry] = []
    state: dict[str, int | bool] = {"visited": 0, "truncated": False}

    def walk(
        directory_path: str,
        directory_handle: int,
        held_connection_path: str,
        prefix: tuple[str, ...],
        depth: int,
    ) -> None:
        if state["truncated"]:
            return
        if depth > MAX_DATASOURCE_ENUMERATION_DEPTH:
            state["truncated"] = True
            return
        held_identity = _windows_file_identity(directory_handle)
        try:
            with os.scandir(directory_path) as iterator:
                names = _bounded_name_types(iterator, state)
        except OSError as error:
            raise DatasourceFileNotFound("Datasource directory could not be enumerated safely") from error
        for name, is_directory in names:
            if state["truncated"]:
                break
            if name.startswith(".") or name in SKIP_DIRS:
                continue
            child_path = os.path.join(directory_path, name)
            if is_directory:
                try:
                    child_handle = _windows_open_checked_directory(
                        child_path,
                        expected_path=child_path,
                        held_authority_path=held_connection_path,
                    )
                except (DatasourceFileError, OSError):
                    continue
                try:
                    walk(child_path, child_handle, held_connection_path, (*prefix, name), depth + 1)
                finally:
                    _kernel32.CloseHandle(child_handle)
                continue
            try:
                metadata = _windows_file_metadata(
                    child_path,
                    expected_path=child_path,
                    held_authority_path=held_connection_path,
                )
            except (DatasourceFileError, OSError):
                continue
            if len(entries) >= maximum_items:
                state["truncated"] = True
                break
            entries.append(AuthorizedDatasourceEntry(
                item_id="/".join((*prefix, name)),
                filename=name,
                media_type=datasource_media_type(name),
                size=metadata.st_size,
                modified_at=metadata.st_mtime,
            ))
        verification_handle = _windows_open_checked_directory(
            directory_path,
            expected_path=directory_path,
            held_authority_path=held_connection_path,
        )
        try:
            if _windows_file_identity(verification_handle) != held_identity:
                raise DatasourceFileRejected("Datasource directory changed while enumerating")
        finally:
            _kernel32.CloseHandle(verification_handle)

    try:
        configured_root_handle = _windows_open_checked_directory(
            binding.configured_root,
            expected_path=binding.configured_root,
            held_authority_path=_windows_normal_path(binding.configured_root),
        )
        held_configured_path = _windows_final_path(configured_root_handle)
        held_configured_identity = _windows_file_identity(configured_root_handle)

        if not binding.relative_parts:
            connection_root_handle = _windows_open_checked_directory(
                binding.connection_root,
                expected_path=binding.connection_root,
                held_authority_path=held_configured_path,
            )
        else:
            for index in range(1, len(binding.relative_parts) + 1):
                expected = os.path.join(binding.configured_root, *binding.relative_parts[:index])
                component_handle = _windows_open_checked_directory(
                    expected,
                    expected_path=expected,
                    held_authority_path=held_configured_path,
                )
                if index == len(binding.relative_parts):
                    connection_root_handle = component_handle
                else:
                    _kernel32.CloseHandle(component_handle)
        if connection_root_handle is None:
            raise DatasourceFileRejected("Datasource connection root could not be anchored")
        held_connection_path = _windows_final_path(connection_root_handle)
        if held_connection_path != _windows_normal_path(binding.connection_root):
            raise DatasourceFileRejected("Datasource connection root does not match its authorized target")
        held_connection_identity = _windows_file_identity(connection_root_handle)

        walk(binding.connection_root, connection_root_handle, held_connection_path, (), 0)

        verification_configured_handle = _windows_open_checked_directory(
            binding.configured_root,
            expected_path=binding.configured_root,
            held_authority_path=held_configured_path,
        )
        if _windows_file_identity(verification_configured_handle) != held_configured_identity:
            raise DatasourceFileRejected("Configured tenant root changed while enumerating")
        verification_connection_handle = _windows_open_checked_directory(
            binding.connection_root,
            expected_path=binding.connection_root,
            held_authority_path=held_configured_path,
        )
        if _windows_file_identity(verification_connection_handle) != held_connection_identity:
            raise DatasourceFileRejected("Datasource connection root changed while enumerating")
    except DatasourceFileError:
        raise
    except OSError as error:
        raise DatasourceFileNotFound("Datasource root could not be enumerated safely") from error
    finally:
        for handle in (
            verification_connection_handle,
            verification_configured_handle,
            connection_root_handle,
            configured_root_handle,
        ):
            if handle is not None:
                _kernel32.CloseHandle(handle)
    entries.sort(key=lambda item: (item.item_id.casefold(), item.filename))
    return AuthorizedDatasourceListing(
        entries=tuple(entries),
        truncated=bool(state["truncated"]),
        visited_entries=int(state["visited"]),
    )


def enumerate_authorized_datasource_files(
    binding: AuthorizedTenantRoot,
    maximum_items: int = MAX_DATASOURCE_ENUMERATION_ITEMS,
) -> AuthorizedDatasourceListing:
    if not isinstance(maximum_items, int) or maximum_items < 1:
        raise DatasourceFileRejected("Datasource enumeration limit is invalid")
    bounded_items = min(maximum_items, MAX_DATASOURCE_ENUMERATION_ITEMS)
    return (
        _enumerate_windows(binding, bounded_items)
        if os.name == "nt"
        else _enumerate_posix(binding, bounded_items)
    )


def read_authorized_datasource_file(
    binding: AuthorizedTenantRoot,
    item_id: str,
    maximum_bytes: int,
) -> AuthorizedDatasourceFile:
    parts = _item_parts(item_id)
    content, modified_at = (
        _read_windows(binding, parts, maximum_bytes)
        if os.name == "nt"
        else _read_posix(binding, parts, maximum_bytes)
    )
    return AuthorizedDatasourceFile(
        content=content,
        filename=parts[-1],
        media_type=_validate_content(parts[-1], content),
        modified_at=modified_at,
    )
